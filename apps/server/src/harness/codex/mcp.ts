import { experimental_createMCPClient as createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { localStateDirectory } from "../../workspace/ai-config";
import type { CodexRpc } from "./rpc";
import type { CodexPlanner } from "./registry";

type Json = Record<string, any>;

export type ConfiguredMcp = {
	servers: Json;
	tools: Record<string, string[]>;
	instructions: string;
	close(): Promise<void>;
};
export const EMPTY_MCP: ConfiguredMcp = {
	servers: {},
	tools: {},
	instructions: "",
	close: async () => {},
};

/** These are execution hints only. Confinement, rather than annotations or command text, enforces source and network access. */
export function mcpEnvironment(
	config: Json,
	state: string,
	runtime = state,
): Record<string, string> {
	let env: Record<string, string> = Object.fromEntries(
		["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "SystemRoot", "SYSTEMROOT"].flatMap(
			name => process.env[name] ? [[name, process.env[name]!]] : [],
		),
	);
	for (let item of config.env_vars ?? []) {
		let name = typeof item === "string" ? item : item.name;
		if (typeof name === "string" && typeof process.env[name] === "string") {
			env[name] = process.env[name]!;
		}
	}
	for (let [name, value] of Object.entries(config.env ?? {})) {
		if (typeof value === "string") env[name] = value;
	}
	// A host browser/executor pipe would delegate outside this process's sandbox.
	for (let name of Object.keys(env)) {
		if (
			/^(BROWSER_USE_|NODE_REPL_INSTRUCTIONS_USE_CASE_|CODEX_|CHOPIN_|GITHUB_|GH_|SSH_|DATABASE_URL$|SESSION_ENCRYPTION_KEY$)/
				.test(name)
		) delete env[name];
	}
	Object.assign(env, {
		XDG_CACHE_HOME: join(state, "cache"),
		XDG_DATA_HOME: join(state, "data"),
		XDG_STATE_HOME: join(state, "state"),
		TMPDIR: join(runtime, "tmp"),
		CODEX_HOME: join(state, "codex"),
		CBM_CACHE_DIR: join(state, "cbm-cache"),
		CBM_RUNTIME_DIR: join(runtime, "cbm-runtime"),
		GIT_ALLOW_PROTOCOL: "",
		GIT_TERMINAL_PROMPT: "0",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
	});
	return env;
}

/** Local stdio MCP servers inherit the configured agent's tool contracts, not its host authority. */
export async function openConfiguredMcp(
	_rpc: CodexRpc,
	config: Json,
	options: {
		directory: string;
		planner: CodexPlanner;
		source: string;
		signal: AbortSignal;
		repositories?: string[];
	},
): Promise<ConfiguredMcp> {
	if (options.planner.nativeTools === false) return EMPTY_MCP;
	let clients: MCPClient[] = [],
		transports: Experimental_StdioMCPTransport[] = [],
		notes: string[] = [];
	let servers: Json = {}, tools: Record<string, string[]> = {};
	let temporary: string[] = [];
	let scope = createHash("sha256").update(options.planner.channelId).digest("hex");
	const close = async () => {
		await Promise.allSettled(clients.map(client => client.close()));
		await Promise.allSettled(transports.map(transport => transport.close()));
		await Promise.allSettled(temporary.map(path => rm(path, { recursive: true, force: true })));
	};
	try {
		for (let [server, raw] of Object.entries(config.mcp_servers ?? {})) {
			let entry = raw as Json;
			if (entry.enabled === false) continue;
			if (typeof entry.command !== "string") {
				notes.push(
					`${server}: remote MCP execution is not confined to this computer; use the supplied document tools for Chopin. Remote write/execute tools are unavailable.`,
				);
				continue;
			}
			if (
				entry.args
				&& (!Array.isArray(entry.args)
					|| entry.args.some((arg: unknown) => typeof arg !== "string"))
			) throw new Error(`Invalid MCP command arguments: ${server}`);
			let hash = createHash("sha256").update(
				server + JSON.stringify([entry.command, entry.args, entry.env]),
			).digest("hex");
			let state = join(options.directory, "mcp-state", scope, hash);
			for (let source of options.repositories ?? [options.source]) {
				let path = relative(source, state);
				if (
					!isAbsolute(path) && path !== ".." && !path.startsWith("../") && !path.startsWith("..\\")
				) {
					throw new Error("MCP state must be outside every original checkout");
				}
			}
			let runtime = await mkdtemp(join(tmpdir(), "chopin-mcp-"));
			temporary.push(runtime);
			let work = options.planner.writable ? options.planner.cwd! : join(runtime, "work");
			for (
				let path of [
					state,
					work,
					join(runtime, "tmp"),
					join(runtime, "cbm-runtime"),
					"cache",
					"data",
					"state",
					"codex",
					"cbm-cache",
				].map(path => path.startsWith("/") ? path : join(state, path))
			) await mkdir(path, { recursive: true, mode: 0o700 });
			let launchFile = join(options.directory, `mcp-launch-${crypto.randomUUID()}.json`);
			await writeFile(
				launchFile,
				JSON.stringify({
					command: [entry.command, ...entry.args ?? []],
					cwd: work,
					env: mcpEnvironment(entry, state, runtime),
					state,
					runtime,
					hidden: localStateDirectory(),
					sources: options.repositories ?? [options.source],
				}),
				{ mode: 0o600 },
			);
			temporary.push(launchFile);
			let transport = new Experimental_StdioMCPTransport({
				command: process.execPath,
				args: [resolve(import.meta.dir, "../../../../connector/src/local-mcp.ts"), launchFile],
				env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
				stderr: "ignore",
			});
			transports.push(transport);
			try {
				let client = await createMCPClient({
					transport,
					protocolVersionDiscovery: false,
					clientName: "chopin-confined-mcp",
					maxRetries: 0,
					initializationOptions: { timeout: 15_000, signal: options.signal },
				});
				clients.push(client);
				let names: string[] = [], approval: Json = {}, blocked = [...entry.disabled_tools ?? []];
				let cursor: string | undefined;
				do {
					let page = await client.listTools({
						params: cursor ? { cursor } : {},
						options: { signal: options.signal, timeout: 15_000 },
					});
					for (let spec of page.tools) {
						if (
							entry.enabled_tools && !entry.enabled_tools.includes(spec.name)
							|| entry.disabled_tools?.includes(spec.name)
						) continue;
						if (/(?:^|[_-])(?:git[_-])?push(?:$|[_-])/i.test(spec.name)) {
							blocked.push(spec.name);
							continue;
						}
						if (names.length >= 200) throw new Error("An MCP server exceeds 200 tools");
						names.push(spec.name);
						let prompt = spec.annotations?.readOnlyHint !== true
							|| spec.annotations?.destructiveHint === true
							|| (entry.tools?.[spec.name]?.approval_mode ?? entry.default_tools_approval_mode)
								=== "prompt";
						approval[spec.name] = { approval_mode: prompt ? "prompt" : "auto" };
					}
					cursor = page.nextCursor;
				} while (cursor);
				// Codex retains native MCP resources/instructions and handles tool approvals. Its server
				// command is replaced, so no tool can execute in an unconfined inherited process.
				servers[server] = {
					...Object.fromEntries(Object.entries(entry).filter(([, value]) => value != null)),
					command: process.execPath,
					args: [resolve(import.meta.dir, "../../../../connector/src/local-mcp.ts"), launchFile],
					cwd: runtime,
					env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
					env_vars: [],
					enabled: true,
					enabled_tools: names,
					disabled_tools: blocked,
					tools: approval,
					default_tools_approval_mode: "prompt",
				};
				tools[server] = names;
				await client.close();

				notes.push(`${server}: connected inside the MCP sandbox. ${client.instructions ?? ""}`);
			} catch (error) {
				await transport.close();
				if (entry.required || options.signal.aborted) throw error;
				notes.push(
					`${server}: failed to initialize inside confinement; no unconfined fallback was used.`,
				);
			}
		}
		return {
			servers,
			tools,
			instructions: `Configured MCP tools:\n${
				notes.join("\n")
			}\nThe MCP working directory is a prototype copy or private runtime directory; original source is ${options.source}. Pass an explicit source/project path for repository queries. Each document has private MCP state and graph indexes; if an index is missing, use its indexing tool (with human approval and persistence:false) before querying. MCP processes restart each turn: JavaScript globals reset, while saved graph indexes persist. Tool confirmations must show the entire call; calls exceeding 10,000 serialized argument characters are declined, so split large inputs. Never use a host browser/executor bridge, commit or push.`,
			close,
		};
	} catch (error) {
		await close();
		throw error;
	}
}
