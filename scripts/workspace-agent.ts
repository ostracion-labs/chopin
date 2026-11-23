/** Human-started bridge for a registered manual local AI connection. */
import { Rpc } from "../apps/server/src/harness/codex/rpc";
import { readSettings, workspaceDirectory } from "./workspace";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AiConnection } from "@chopin/protocol/local-ai";

async function main() {
	let id = process.argv[2];
	if (!id || !/^[a-z][a-z0-9-]{0,49}$/.test(id)) {
		throw new Error("Use: bun scripts/workspace-agent.ts CONNECTION_ID");
	}
	let directory = workspaceDirectory();
	let settings = readSettings(directory);
	let origin = `http://127.0.0.1:${settings.port}`;
	let path = `/api/workspace/agents/${id}`;
	let controller = new AbortController();
	let lease = crypto.randomUUID();
	const call = async (suffix: string, body?: unknown) => {
		let response = await fetch(origin + path + suffix, {
			method: body ? "POST" : "GET",
			headers: { authorization: `Bearer ${settings.token}`, "content-type": "application/json" },
			...(body ? { body: JSON.stringify(body) } : {}),
			signal: controller.signal,
		});
		let value = await response.json() as Record<string, any>;
		if (!response.ok) throw new Error(value.error ?? "Bridge request failed");
		return value;
	};
	let connection = (await call("")).connection as AiConnection;
	let command = connection.transport === "codex"
		? [
			...connection.command,
			"app-server",
			"--listen",
			"stdio://",
			"-c",
			"features.apps=false",
			"-c",
			"features.plugins=false",
			"-c",
			"features.hooks=false",
			"-c",
			"features.multi_agent=false",
			"-c",
			'web_search="disabled"',
		]
		: [
			process.execPath,
			resolve(import.meta.dir, "../apps/connector/src/local-ai.ts"),
			JSON.stringify(connection),
		];
	let scratch = await mkdtemp(join(directory, "bridge-"));
	let rpc = new Rpc(command[0]!, command.slice(1), scratch);
	let posts = Promise.resolve();
	const send = (message: unknown) => {
		posts = posts.then(() => call("/events", { lease, message })).then(() => {});
		void posts.catch(() => controller.abort());
	};
	rpc.watch(send);
	void rpc.closed.then(() => controller.abort());
	let stop = () => controller.abort();
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	try {
		console.info(`Attached ${connection.name}. Keep this terminal open; Ctrl+C disconnects it.`);
		while (!controller.signal.aborted) {
			let batch = await call("/poll", { lease });
			for (let message of batch.messages) {
				if (message.method && message.id !== undefined) {
					void rpc.request(message.method, message.params ?? {}).then(
						result => send({ id: message.id, result }),
						error => send({ id: message.id, error: { message: error.message } }),
					);
				} else if (message.method) rpc.notify(message.method);
				else if (message.id !== undefined) rpc.reply(message.id, message.result);
			}
		}
	} finally {
		rpc.close();
		await rpc.closed;
		await rm(scratch, { recursive: true, force: true });
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
	}
}
if (import.meta.main) {
	main().catch(error => {
		console.error(error instanceof Error ? error.message : "Attachment failed");
		process.exitCode = 1;
	});
}
