import { afterAll, expect, test } from "bun:test";
import { experimental_createMCPClient as createMCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { launchLocalMcp } from "../../../../connector/src/local-mcp";
import { inspectSandbox } from "../../../../connector/src/sandbox";
import { mcpEnvironment, openConfiguredMcp } from "./mcp";

let root = await mkdtemp(join(tmpdir(), "chopin-mcp-contract-"));
let report = await inspectSandbox({ directory: join(root, "probe"), offline: true });
let realSandbox = test.skipIf(report.report.engine === "none");
afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

test("MCP environments remove host delegation and keep state in owned directories", () => {
	let env = mcpEnvironment(
		{
			env: {
				BROWSER_USE_ACCESS_PIPE_PATH: "/host/executor",
				NODE_REPL_INSTRUCTIONS_USE_CASE_BROWSER: "host",
				CHOPIN_WORKSPACE_TOKEN: "secret",
				DATABASE_URL: "secret",
				NODE_REPL_NODE_PATH: "/tools/node",
				GIT_ALLOW_PROTOCOL: "https",
				SAFE_SETTING: "kept",
			},
		},
		"/private/state",
		"/private/runtime",
	);
	expect(env.BROWSER_USE_ACCESS_PIPE_PATH).toBeUndefined();
	expect(env.CHOPIN_WORKSPACE_TOKEN).toBeUndefined();
	expect(env.DATABASE_URL).toBeUndefined();
	expect(env.SAFE_SETTING).toBe("kept");
	expect(env.NODE_REPL_NODE_PATH).toBe("/tools/node");
	expect(env.GIT_ALLOW_PROTOCOL).toBe("");
	expect(env.CBM_RUNTIME_DIR).toBe("/private/runtime/cbm-runtime");
});

test("classifier workers do not initialize any inherited MCP process", async () => {
	let mcp = await openConfiguredMcp({} as never, {
		mcp_servers: { bad: { command: "must-never-run", required: true } },
	}, {
		directory: root,
		source: root,
		signal: AbortSignal.timeout(1000),
		planner: { nativeTools: false } as never,
	});
	expect(mcp.servers).toEqual({});
	expect(mcp.tools).toEqual({});
});

realSandbox(
	"host sockets and writable ancestors of source are refused before any tool can run",
	async () => {
		let directory = await mkdtemp(join(root, "socket-"));
		let source = join(directory, "source"), state = join(directory, "state");
		await mkdir(source);
		await mkdir(state);
		let launch = {
			command: [process.execPath],
			env: { PATH: process.env.PATH! },
			cwd: state,
			state,
			runtime: state,
			hidden: join(directory, "hidden"),
			sources: [source],
		};
		await expect(launchLocalMcp({ ...launch, cwd: directory })).rejects.toThrow("overlap");
		if (process.platform === "win32") return;
		let listener = createServer(socket => socket.end("host executor"));
		let path = join(source, "host.sock");
		await new Promise<void>(done => listener.listen(path, done));
		try {
			await expect(launchLocalMcp(launch)).rejects.toThrow("host socket");
		} finally {
			await new Promise<void>(done => listener.close(() => done()));
		}
	},
);

realSandbox(
	"confined MCP tools can execute in a prototype but cannot write originals, bypass through false annotations, use host networking or push outside the copy",
	async () => {
		let directory = await mkdtemp(join(root, "case-"));
		let source = join(directory, "original"),
			copy = join(directory, "copy"),
			state = join(directory, "state");
		await mkdir(source);
		await mkdir(copy);
		await mkdir(state);
		await writeFile(join(source, "source.txt"), "human source");
		let git = (cwd: string, args: string[]) => {
			let result = spawnSync("git", args, { cwd, encoding: "utf8" });
			if (result.status !== 0) throw new Error(result.stderr);
			return result.stdout.trim();
		};
		git(source, ["init", "-b", "main"]);
		git(source, ["add", "source.txt"]);
		git(source, [
			"-c",
			"user.name=fixture",
			"-c",
			"user.email=fixture@example.test",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-m",
			"baseline",
		]);
		let head = git(source, ["rev-parse", "HEAD"]);
		let server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response("host network must be unreachable"),
		});
		let config = {
			mcp_servers: {
				test: {
					command: process.execPath,
					args: [
						resolve(import.meta.dir, "../../../../connector/src/testing/confined-mcp-server.ts"),
					],
					required: true,
				},
			},
		};
		let mcp = await openConfiguredMcp({} as never, config, {
			directory: state,
			source,
			repositories: [source],
			signal: AbortSignal.timeout(20_000),
			planner: {
				channelId: "doc",
				repositoryId: "repo",
				cwd: copy,
				writable: true,
				humanInput: {},
			} as never,
		});
		let spec = mcp.servers.test;
		expect(spec.tools.read_file.approval_mode).toBe("auto");
		expect(spec.tools.execute.approval_mode).toBe("prompt");
		expect(spec.enabled_tools).not.toContain("git_push");
		let client = await createMCPClient({
			transport: new Experimental_StdioMCPTransport({
				command: spec.command,
				args: spec.args,
				env: spec.env,
				stderr: "ignore",
			}),
			protocolVersionDiscovery: false,
		});
		try {
			let read = await client.callTool({
				name: "read_file",
				arguments: { path: join(source, "source.txt") },
			});
			expect(read.isError).not.toBe(true);
			let lie = await client.callTool({
				name: "lying_read",
				arguments: { path: join(source, "source.txt") },
			});
			expect(lie.isError).toBe(true);
			let result = await client.callTool({
				name: "execute",
				arguments: {
					code: `let fs = await import('node:fs/promises'); await fs.writeFile(${
						JSON.stringify(join(copy, "prototype.txt"))
					}, 'copy change'); let originalRefused = false; try { await fs.writeFile(${
						JSON.stringify(join(source, "source.txt"))
					}, 'must fail'); } catch { originalRefused = true; } let networkRefused = false; try { await fetch(${
						JSON.stringify(server.url.origin)
					}, {signal: AbortSignal.timeout(500)}); } catch { networkRefused = true; } return { originalRefused, networkRefused };`,
				},
			});
			expect(JSON.parse((result.content as any[])[0].text)).toEqual({
				originalRefused: true,
				networkRefused: true,
			});
			expect(await readFile(join(copy, "prototype.txt"), "utf8")).toBe("copy change");
			expect(await readFile(join(source, "source.txt"), "utf8")).toBe("human source");
			let push = await client.callTool({
				name: "execute",
				arguments: {
					code:
						`let {spawnSync} = await import('node:child_process'); let result = spawnSync('git', ['-c', 'protocol.file.allow=always', 'push', ${
							JSON.stringify(source)
						}, 'HEAD:refs/heads/forbidden'], {cwd:${
							JSON.stringify(source)
						}, encoding:'utf8'}); return {refused:result.status !== 0};`,
				},
			});
			expect(JSON.parse((push.content as any[])[0].text)).toEqual({ refused: true });
			expect(git(source, ["rev-parse", "HEAD"])).toBe(head);
			expect(git(source, ["for-each-ref", "--format=%(refname)"])).not.toContain("forbidden");
		} finally {
			server.stop(true);
			await client.close();
			await mcp.close();
		}
	},
	30_000,
);
