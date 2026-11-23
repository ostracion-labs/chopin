/** Private stdio MCP launch. The tool server and every subprocess stay in Sandbox. */
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createSandbox, findProgram } from "./sandbox";
import { PROCESSES, stopBackend } from "./planner";
import { repositoryAt } from "./git-host";

export type LocalMcpLaunch = {
	command: string[];
	env: Record<string, string>;
	state: string;
	runtime: string;
	cwd: string;
	hidden: string;
	sources: string[];
};

export async function launchLocalMcp(launch: LocalMcpLaunch) {
	let sources = await Promise.all(launch.sources.map(source => realpath(source)));
	let protectedPaths = sources.flatMap(source => {
		let repo = repositoryAt(source);
		return [source, ...repo ? [repo.commonDir, repo.gitDir] : []];
	});
	// These grants are host-created state/copies, never a person's original repository.
	for (let writable of [launch.state, launch.runtime, launch.cwd]) {
		let path = await realpath(writable);
		for (let source of protectedPaths) {
			if (contains(source, path) || contains(path, source)) {
				throw new Error("MCP writable paths cannot overlap an original checkout");
			}
		}
	}
	let sandbox = await createSandbox({
		directory: launch.hidden,
		server: "http://127.0.0.1:9",
		offline: true,
		settings: { require: true },
	});
	if (sandbox.report.engine === "none") {
		await sandbox.close();
		throw new Error(`MCP confinement is unavailable: ${sandbox.report.reason}`);
	}
	// A read-only bind of a host socket still permits connect(). Do not expose the home,
	// /run, /var or /tmp, and refuse sockets in the explicitly exposed user trees. Tools
	// cannot plant new sockets there because those trees are held read-only.
	let readable = [...protectedPaths];
	let executable = isAbsolute(launch.command[0]!)
		? launch.command[0]
		: findProgram(launch.command[0]!, launch.env);
	if (!executable) throw new Error("The configured MCP executable is unavailable");
	readable.push(await realpath(executable));
	for (let arg of launch.command.slice(1)) {
		try {
			let at = await realpath(resolve(launch.cwd, arg));
			if ((await stat(at)).isFile()) readable.push(dirname(at));
		} catch { /* A command option, not a script. */ }
	}
	for (let name of ["NODE_PATH", "NODE_REPL_NODE_MODULE_DIRS", "PYTHONPATH", "VIRTUAL_ENV"]) {
		for (let path of launch.env[name]?.split(delimiter) ?? []) {
			if (isAbsolute(path)) readable.push(await realpath(path));
		}
	}
	if (launch.env.NODE_REPL_NODE_PATH) readable.push(await realpath(launch.env.NODE_REPL_NODE_PATH));
	let system = process.platform === "win32"
		? [
			launch.env.SystemRoot ?? launch.env.SYSTEMROOT ?? "C:\\Windows",
			process.env.ProgramFiles ?? "C:\\Program Files",
		]
		: ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/opt"];
	for (let path of system) {
		try {
			readable.push(await realpath(path));
		} catch { /* Not installed on this host. */ }
	}
	readable = [...new Set(readable)].filter((path, _index, paths) =>
		!paths.some(parent => parent !== path && contains(parent, path))
	);
	for (let path of readable) await refuseHostSockets(path);
	let child = sandbox.spawn({
		readableOnly: true,
		readable,
		command: launch.command,
		cwd: launch.cwd,
		env: launch.env,
		stdin: "pipe",
		own: [launch.state, launch.runtime, launch.cwd],
		writable: [launch.state, launch.runtime, launch.cwd],
	});
	process.stdin.pipe(child.stdin!);
	child.stdin!.on("error", () => {
		void stop();
	});
	child.stdout.pipe(process.stdout);
	child.stderr.pipe(process.stderr);
	let stopped = false;
	let stop = async () => {
		if (stopped) return;
		stopped = true;
		await stopBackend(child, { ...PROCESSES, graceMs: 500 });
		await sandbox.close();
	};
	// The owning turn enforces prototype deadlines. An unanswered human Decision
	// must not expire this server; closing stdin or its parent stops the process group.
	let ended = () => {
		void stop();
	};
	process.once("SIGTERM", ended);
	process.once("SIGINT", ended);
	process.stdin.once("end", ended);
	child.once("error", ended);
	child.once("close", code => {
		void stop().finally(() => {
			process.exitCode = code ?? 1;
			process.stdin.destroy();
		});
	});
}

/** Bound inspection to the explicitly granted trees; failure never opens the host as a fallback. */
async function refuseHostSockets(root: string) {
	let pending = [root], seen = new Set<string>();
	while (pending.length) {
		let path = pending.pop()!;
		if (seen.size >= 250_000) throw new Error("MCP read scope is too large to validate safely");
		if (seen.has(path)) continue;
		seen.add(path);
		let info;
		try {
			info = await lstat(path);
		} catch (error) {
			if (["EACCES", "EPERM", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) {
				continue;
			}
			throw error;
		}
		if (info.isSocket()) {
			throw new Error("MCP read scope contains a host socket; remove that scope before launching");
		}
		if (info.isDirectory()) {
			let entries;
			try {
				entries = await readdir(path, { withFileTypes: true });
			} catch (error) {
				if (["EACCES", "EPERM", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) {
					continue;
				}
				throw error;
			}
			for (let entry of entries) {
				if (entry.isSocket()) {
					throw new Error(
						"MCP read scope contains a host socket; remove that scope before launching",
					);
				}
				if (entry.isDirectory()) pending.push(join(path, entry.name));
			}
		}
	}
}

function contains(parent: string, child: string) {
	let path = relative(parent, child);
	return !isAbsolute(path) && path !== ".." && !path.startsWith("../") && !path.startsWith("..\\");
}

if (import.meta.main) {
	launchLocalMcp(JSON.parse(await readFile(process.argv[2]!, "utf8"))).catch(error => {
		console.error(error instanceof Error ? error.message : "MCP confinement failed");
		process.exitCode = 1;
	});
}
