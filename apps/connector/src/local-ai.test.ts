import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { serveLocalAcp } from "./local-ai";
import type { Launch, Spawned } from "./sandbox";
import type { AiConnection } from "@chopin/protocol/local-ai";

const config: AiConnection = {
	id: "test",
	name: "Test ACP",
	command: [process.execPath, import.meta.dir + "/testing/local-ai-agent.ts"],
	transport: "acp",
	mode: "launch",
	launchApproved: true,
	registeredAt: new Date().toISOString(),
	modelHosts: ["model.example.com"],
	models: [],
};
test("ACP bridges model/thinking selection, host tools and human approvals through the sandbox seam", async () => {
	let input = new PassThrough();
	let messages: any[] = [];
	let launches: Launch[] = [];
	let completed = Promise.withResolvers<void>();
	let sequence = 0;
	let replies = new Map<number, ReturnType<typeof Promise.withResolvers<any>>>();
	let close = await serveLocalAcp(config, {
		input,
		sandboxFactory: async options => {
			expect(options.hostsOnly).toContain("model.example.com");
			expect(options.hostsOnly).not.toContain("github.com");
			expect(options.settings?.require).toBe(true);
			return {
				report: { engine: "bubblewrap" },
				spawn: launch => {
					launches.push(launch);
					return spawn(launch.command[0]!, launch.command.slice(1), {
						cwd: launch.cwd,
						env: launch.env,
						stdio: "pipe",
						detached: true,
					}) as Spawned;
				},
				close: async () => {},
			};
		},
		write: message => {
			messages.push(message);
			if (message.method === "turn/completed") completed.resolve();
			if (message.method === "item/commandExecution/requestApproval") {
				input.write(JSON.stringify({ id: message.id, result: { decision: "accept" } }) + "\n");
			} else if (message.method === "item/tool/call") {
				input.write(
					JSON.stringify({
						id: message.id,
						result: {
							success: true,
							contentItems: [{ type: "inputText", text: "current document" }],
						},
					}) + "\n",
				);
			} else if (message.id) {
				let pending = replies.get(message.id);
				if (pending) {
					replies.delete(message.id);
					if (message.error) pending.reject(new Error(message.error.message));
					else pending.resolve(message.result);
				}
			}
		},
	});
	const request = (method: string, params: object = {}) => {
		let id = ++sequence;
		let pending = Promise.withResolvers<any>();
		replies.set(id, pending);
		input.write(JSON.stringify({ id, method, params }) + "\n");
		return pending.promise;
	};
	try {
		let catalog = await request("model/list");
		expect(catalog.data.map((item: any) => item.model)).toEqual(["sol", "luna"]);
		let thread = await request("thread/start", {
			cwd: import.meta.dir,
			sandbox: "read-only",
			developerInstructions: "read this document",
			dynamicTools: [{ name: "read_plan", inputSchema: { type: "object" } }],
			approvalPolicy: { granular: { sandbox_approval: false } },
		});
		expect(thread.sandbox.type).toBe("readOnly");
		expect(launches.every(launch => !launch.own)).toBe(true);
		await request("turn/start", {
			threadId: thread.thread.id,
			model: "luna",
			effort: "high",
			input: [{ type: "text", text: "read" }],
		});
		await completed.promise;
		expect(messages.find(message => message.method === "item/agentMessage/delta").params.delta)
			.toContain("luna/high: selected");
		expect(messages.find(message => message.method === "item/agentMessage/delta").params.delta)
			.toContain("current document");
		await expect(
			request("turn/start", { threadId: thread.thread.id, model: "invented", input: [] }),
		).rejects.toThrow("does not offer");
	} finally {
		await close();
		input.destroy();
	}
});

test("ACP refuses an unavailable sandbox before any agent command starts", async () => {
	let input = new PassThrough();
	await expect(
		serveLocalAcp(config, {
			input,
			sandboxFactory: async () => ({
				report: { engine: "none", reason: "required dependency missing" },
				spawn: () => {
					throw new Error("must never start");
				},
				close: async () => {},
			}),
		}),
	).rejects.toThrow("requires a working sandbox");
	input.destroy();
});
