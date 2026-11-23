/** Single-owner local Chopin launcher. Codex is opt-in; Git execution remains disabled. */
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { AiSettings, roleConnection } from "../apps/server/src/workspace/ai-config";
import { workspaceRepositories, workspaceToken } from "../apps/server/src/workspace/config";
import type { LocalAiConfiguration } from "../packages/protocol/local-ai";

export type LocalSettings = {
	version: 1;
	token: string;
	port: number;
	databaseUrl: string;
	repositories: { name: string; path: string }[];
	agent?: "codex" | "off";
	codexCommand?: string;
};

const ROOT = resolve(import.meta.dir, "..");
const DATABASE = "postgresql://chopin:chopin@127.0.0.1:55432/chopin?sslmode=disable";

export function workspaceDirectory(env = process.env): string {
	return resolve(
		env.CHOPIN_WORKSPACE_DIR
			|| join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "chopin", "workspace"),
	);
}

export function readSettings(directory: string): LocalSettings {
	let file = join(directory, "settings.json");
	if (!lstatSync(file).isFile()) throw new Error("Workspace settings must be a regular file");
	let value: unknown = JSON.parse(readFileSync(file, "utf8"));
	if (!value || typeof value !== "object") throw new Error("Invalid workspace settings");
	let record = value as LocalSettings;
	if (
		record.version !== 1 || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535
		|| typeof record.databaseUrl !== "string" || !/^postgres(?:ql)?:\/\//.test(record.databaseUrl)
		|| record.agent !== undefined && !["codex", "off"].includes(record.agent)
		|| record.codexCommand !== undefined
			&& (typeof record.codexCommand !== "string" || !record.codexCommand.startsWith("/"))
	) throw new Error("Invalid workspace settings");
	workspaceToken(record.token);
	let repositories = workspaceRepositories(JSON.stringify(record.repositories));
	return { ...record, repositories: repositories.map(({ name, path }) => ({ name, path })) };
}

function save(directory: string, value: LocalSettings): void {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	chmodSync(directory, 0o700);
	let file = join(directory, "settings.json");
	if (existsSync(file) && !lstatSync(file).isFile()) {
		throw new Error("Workspace settings must be a regular file");
	}
	writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
	chmodSync(file, 0o600);
}

export function workspaceEnvironment(settings: LocalSettings): Record<string, string> {
	return {
		CHOPIN_MODE: "workspace",
		CHOPIN_WORKSPACE_TOKEN: settings.token,
		CHOPIN_WORKSPACE_DIR: workspaceDirectory(),
		CHOPIN_WORKSPACES: JSON.stringify(settings.repositories),
		CHOPIN_WORKSPACE_AGENT: settings.agent ?? "off",
		CHOPIN_CODEX_COMMAND: settings.codexCommand ?? "codex",
		CHOPIN_CODEX_STATE_DIR: join(workspaceDirectory(), "codex"),
		SERVER_HOST: "127.0.0.1",
		PORT: String(settings.port),
		APP_ORIGIN: `http://127.0.0.1:${settings.port}`,
		DATABASE_URL: settings.databaseUrl,
		AGENT: settings.agent === "codex" ? "on" : "off",
		BACKGROUND_JOBS: "off",
		WEB_RESEARCH: "off",
		CONVERSATION_PLAN: "off",
		LIVE_BUILD: "off",
		LIVE_SPIKES: "off",
	};
}

/** Keep setup reachable while refusing to activate any incomplete AI configuration. */
export function workspaceStartupEnvironment(
	settings: LocalSettings,
	ai: LocalAiConfiguration,
): { env: Record<string, string>; notice?: string } {
	let env = {
		...workspaceEnvironment(settings),
		CHOPIN_LOCAL_AI: "",
		CHOPIN_WORKSPACE_AGENT: "off",
		AGENT: "off",
	};
	if (settings.agent === "off" || !Object.keys(ai.roles).length) return { env };
	try {
		for (let role of ["planner", "classifier", "prototyping"] as const) roleConnection(ai, role);
	} catch (error) {
		return {
			env,
			notice: `AI remains off: ${
				error instanceof Error ? error.message : "Finish AI setup"
			}. Open /settings/ai to finish setup.`,
		};
	}
	env.CHOPIN_LOCAL_AI = JSON.stringify(ai);
	env.CHOPIN_WORKSPACE_AGENT = "codex";
	env.AGENT = "on";
	return { env };
}

/** A quoted systemd word; percent signs are specifiers even in quotes. */
function unitArgument(value: string): string {
	return '"'
		+ value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll(
			"\n",
			"\\n",
		) + '"';
}

export function workspaceUnit(directory: string, root: string, bun: string): string {
	return `[Unit]\nDescription=Chopin local workspace\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory=${
		root.replaceAll("\\", "\\\\").replaceAll("%", "%%").replaceAll("\n", "\\n")
	}\nEnvironment=${unitArgument(`CHOPIN_WORKSPACE_DIR=${directory}`)}\nExecStart=${
		unitArgument(bun)
	} ${
		unitArgument(join(root, "scripts/workspace.ts"))
	} start\nRestart=on-failure\nRestartSec=5\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`
		.replace(/^ExecStart=(.*)$/m, line => line.replaceAll("$", () => "$$"));
}

async function run(command: string[], env = process.env): Promise<void> {
	let child = Bun.spawn(command, {
		cwd: ROOT,
		env,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	let forward = () => child.kill("SIGTERM");
	process.on("SIGINT", forward);
	process.on("SIGTERM", forward);
	try {
		let code = await child.exited;
		if (code !== 0) throw new Error(`${command[0]} exited with code ${code}`);
	} finally {
		process.off("SIGINT", forward);
		process.off("SIGTERM", forward);
	}
}

async function main(args: string[]): Promise<void> {
	let directory = workspaceDirectory();
	let [command, ...rest] = args;
	if (command === "db") {
		let action = rest[0];
		if (!action || !["up", "down", "status"].includes(action)) {
			throw new Error("Use: workspace db up|down|status");
		}
		let operation = action === "up"
			? ["up", "-d", "--wait", "db"]
			: action === "down"
			? ["down"]
			: ["ps"];
		await run(["docker", "compose", "-f", join(ROOT, "compose.workspace.yaml"), ...operation]);
		return;
	}
	if (command === "init") {
		if (existsSync(join(directory, "settings.json"))) {
			throw new Error("Workspace already initialized; use add");
		}
		let settings: LocalSettings = {
			version: 1,
			token: randomBytes(32).toString("base64url"),
			port: 8787,
			databaseUrl: process.env.DATABASE_URL || DATABASE,
			repositories: [],
		};
		if (rest.length) {
			if (rest.length !== 2) {
				throw new Error("Use: workspace init local/project /absolute/checkout");
			}
			settings.repositories = workspaceRepositories(
				JSON.stringify([{ name: rest[0], path: realpathSync(resolve(rest[1]!)) }]),
			)
				.map(({ name, path }) => ({ name, path }));
		}
		save(directory, settings);
		console.info(`Local workspace initialized. Settings: ${join(directory, "settings.json")}`);
		return;
	}
	if (command === "service") {
		if (process.platform !== "linux") {
			throw new Error("Background service installation currently supports Linux systemd");
		}
		let action = rest[0];
		if (
			!action || !["install", "start", "stop", "restart", "status", "uninstall"].includes(action)
		) {
			throw new Error("Use: workspace service install|start|stop|restart|status|uninstall");
		}
		let unit = "chopin-workspace.service";
		if (action === "install") {
			readSettings(directory);
			let file = join(homedir(), ".config", "systemd", "user", unit);
			if (existsSync(file)) throw new Error(`Service already exists: ${file}`);
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, workspaceUnit(directory, ROOT, process.execPath), {
				mode: 0o600,
				flag: "wx",
			});
			await run(["systemctl", "--user", "daemon-reload"]);
			await run(["systemctl", "--user", "enable", "--now", unit]);
			console.info(
				"Service installed. For startup before login, enable user lingering with loginctl enable-linger.",
			);
		} else if (action === "uninstall") {
			await run(["systemctl", "--user", "disable", "--now", unit]);
			let file = join(homedir(), ".config", "systemd", "user", unit);
			if (existsSync(file)) await Bun.file(file).delete();
			await run(["systemctl", "--user", "daemon-reload"]);
		} else await run(["systemctl", "--user", action, unit]);
		return;
	}
	if (!command || command === "help" || command === "--help") {
		console.info(
			"Chopin local workspace\n  init [local/project /checkout]\n  add local/project /checkout\n  agent codex|off\n  db up|down|status\n  prepare\n  start\n  key\n  codex-config\n  service install|start|stop|restart|status|uninstall\n\nSet CHOPIN_WORKSPACE_DIR to choose a different private settings directory.",
		);
		return;
	}
	let settings = readSettings(directory);
	if (command === "agent") {
		if (rest.length !== 1 || !["codex", "off"].includes(rest[0]!)) {
			throw new Error("Use: workspace agent codex|off");
		}
		if (rest[0] === "codex") {
			let roles = await new AiSettings(directory).read();
			for (let role of ["planner", "classifier", "prototyping"] as const) {
				roleConnection(roles, role);
			}
			settings.agent = "codex";
		} else {
			settings.agent = "off";
			delete settings.codexCommand;
		}
		save(directory, settings);
		console.info(`Document Chat: ${settings.agent ?? "off"}. Restart Chopin to apply.`);
		return;
	}
	if (command === "add") {
		if (rest.length !== 2) throw new Error("Use: workspace add local/project /absolute/checkout");
		let repositories = workspaceRepositories(
			JSON.stringify([...settings.repositories, {
				name: rest[0],
				path: realpathSync(resolve(rest[1]!)),
			}]),
		);
		settings.repositories = repositories.map(({ name, path }) => ({ name, path }));
		save(directory, settings);
		console.info("Checkout registered. Restart Chopin to refresh the catalogue.");
		return;
	}
	if (command === "key") {
		console.info(settings.token);
		return;
	}
	if (command === "codex-config") {
		console.info(
			`[mcp_servers.chopin-local]\nurl = "http://127.0.0.1:${settings.port}/mcp"\nbearer_token_env_var = "CHOPIN_WORKSPACE_TOKEN"\ndefault_tools_approval_mode = "prompt"`,
		);
		return;
	}
	let ai = await new AiSettings(directory).read();
	let startup = workspaceStartupEnvironment(settings, ai);
	if (startup.notice) console.info(startup.notice);
	let env = { ...process.env, ...startup.env };
	if (command === "prepare") {
		await run([process.execPath, "run", "--filter", "@chopin/web", "build"], env);
		await run([process.execPath, "run", "migrate"], env);
		return;
	}
	if (command === "start") {
		if (!existsSync(join(ROOT, "apps/web/dist/index.html"))) {
			throw new Error("Build the client with: bun run workspace prepare");
		}
		console.info(
			`Local workspace: ${env.APP_ORIGIN}. Sign in with the key from bun run workspace key.`,
		);
		await run([process.execPath, "apps/server/src/main.ts"], env);
		return;
	}
	throw new Error(`Unknown workspace command: ${command}`);
}

if (import.meta.main) {
	main(process.argv.slice(2)).catch(error => {
		console.error(error instanceof Error ? error.message : "Workspace command failed");
		process.exitCode = 1;
	});
}
