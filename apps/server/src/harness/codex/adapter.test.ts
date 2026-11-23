import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { tool } from "ai";
import { z } from "zod";

import { EMPTY_MCP } from "./mcp";
import { CODEX_APPROVALS, CODEX_SANDBOX, createCodexAdapter } from "./adapter";
import type { CodexRpc, Message } from "./rpc";
import type { CodexPlanner } from "./registry";
import type { PlannerTurn } from "../turn-level";
import { openPlannerSession } from "../session";
import { create, translate } from "../../chat/service";
import type { Room } from "../../chat/service";

class Fake implements CodexRpc {
	calls: { method: string; params: Record<string, any> }[] = [];
	replies: { id: string | number; result: any }[] = [];
	listeners = new Set<(message: Message) => void>();
	closed: Promise<void>;
	end!: () => void;
	thread = 0;
	turn = 0;
	unsafe = false;
	inventory?: (name: string) => Record<string, any>[];
	account = "chatgpt";
	auto = false;
	mcpAuto = false;
	constructor() {
		this.closed = new Promise(resolve => {
			this.end = resolve;
		});
	}
	async request(method: string, params: Record<string, unknown>) {
		this.calls.push({ method, params });
		if (method === "account/read") return { account: { type: this.account } };
		if (method === "mcpServerStatus/list") {
			return { data: this.inventory?.(String(params.serverName)) ?? [] };
		}
		if (method === "config/read") {
			return {
				config: {
					model: "chosen-model",
					mcp_servers: { push_capable: { command: "must-never-run" } },
				},
			};
		}
		if (method === "model/list") {
			return {
				data: [{
					model: "chosen-model",
					displayName: "Chosen",
					supportedReasoningEfforts: [{ reasoningEffort: "high" }],
					isDefault: true,
				}],
			};
		}
		if (method === "thread/start" || method === "thread/resume") {
			return {
				thread: { id: params.threadId ?? `thread-${++this.thread}` },
				cwd: params.cwd,
				modelProvider: "openai",
				sandbox: this.unsafe
					? { type: "dangerFullAccess" }
					: params.sandbox === "workspace-write"
					? {
						type: "workspaceWrite",
						writableRoots: [],
						networkAccess: false,
						excludeSlashTmp: true,
						excludeTmpdirEnvVar: true,
					}
					: CODEX_SANDBOX,
				approvalPolicy: CODEX_APPROVALS,
				approvalsReviewer: "user",
			};
		}
		if (method === "turn/start") {
			let turn = `turn-${++this.turn}`;
			if (this.mcpAuto) {
				setTimeout(() => {
					let params = {
						threadId: this.calls.findLast(call => call.method === "turn/start")!.params.threadId,
						turnId: turn,
					};
					let item = {
						type: "mcpToolCall",
						id: "graph-read",
						server: "codebase-memory-mcp",
						tool: "list_projects",
						arguments: {},
					};
					this.emit({ method: "item/started", params: { ...params, item } });
					this.emit({
						method: "item/completed",
						params: {
							...params,
							item: {
								...item,
								result: { content: [{ type: "text", text: "Private graph projects" }] },
							},
						},
					});
					this.emit({
						method: "item/agentMessage/delta",
						params: { ...params, itemId: "reply", delta: "The graph query completed." },
					});
					this.complete(String(params.threadId));
				}, 1);
			}
			if (this.auto) {
				setTimeout(() =>
					this.emit({
						id: 100,
						method: "item/tool/call",
						params: {
							threadId: params.threadId,
							turnId: turn,
							tool: "read_plan",
							callId: "read",
							arguments: {},
						},
					}), 1);
			}
			return { turn: { id: turn } };
		}
		if (method === "turn/interrupt") this.complete(String(params.threadId), "interrupted");
		return {};
	}
	reply(id: number | string, result: unknown) {
		this.replies.push({ id, result });
		if (this.auto && id === 100) {
			let threadId = String(
				this.calls.findLast(call => call.method === "turn/start")!.params.threadId,
			);
			this.emit({
				method: "item/agentMessage/delta",
				params: { threadId, itemId: "reply", delta: "I read the document." },
			});
			this.complete(threadId);
		}
	}
	notify() {}
	watch(listener: (message: Message) => void) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	emit(message: Message) {
		for (let listener of this.listeners) listener(message);
	}
	complete(threadId: string, status = "completed") {
		this.emit({ method: "turn/completed", params: { threadId, turn: { status } } });
	}
	close() {
		this.emit({ method: "chopin/disconnected" });
		this.end();
	}
}

let directories: string[] = [];
let harnesses: ReturnType<typeof createCodexAdapter>[] = [];
afterEach(async () => {
	await Promise.all(harnesses.splice(0).map(harness => harness.shutdown()));
	for (let directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it("projects a verified native MCP call through the real Planner session and Chat guard without stopping the reply", async () => {
	let directory = mkdtempSync(join(tmpdir(), "chopin-codex-chat-"));
	directories.push(directory);
	let fake = new Fake();
	fake.mcpAuto = true;
	fake.inventory = name =>
		name === "codebase-memory-mcp"
			? [{ name, runtimeStatus: "connected", tools: { list_projects: {} } }]
			: [{ name, runtimeStatus: "disabled", tools: {} }];
	let harness = createCodexAdapter({
		connect: () => fake,
		stateDirectory: directory,
		repositories: [{ id: "repo", name: "local/project", path: directory }],
		mcpFactory: async () => ({
			servers: { "codebase-memory-mcp": { command: "confined-launcher" } },
			tools: { "codebase-memory-mcp": ["list_projects"] },
			instructions: "",
			close: async () => {},
		}),
	});
	harnesses.push(harness);
	let agent = new HarnessAgent({
		harness,
		activeTools: ["read_plan"],
		tools: {
			read_plan: tool({ inputSchema: z.object({}), execute: async () => "Current document" }),
		},
	});
	let controller = new AbortController();
	let owner = {
		signal: controller.signal,
		revalidate: async () => true,
		currentToken: () => "test-token",
		repository: { id: "repo", owner: "local", name: "project", defaultBranch: "main" },
	};
	let opened = await openPlannerSession(owner as never, {
		room: { id: "mcp-document", plan: {}, server: {} } as never,
		repository: owner.repository,
		harness: "local-ai",
		instructions: "Read the graph",
	}, {
		agent: agent as never,
		registerCredential: () => () => {},
		createSandbox: async () =>
			({
				defaultWorkingDirectory: directory,
				run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
				destroy: async () => {},
			}) as never,
	});
	if (!opened.ok) throw new Error("Planner session did not open", { cause: opened.error });
	let chat = create();
	chat.agent = opened.value;
	chat.turnController = controller;
	let context = {
		chat,
		room: "mcp-document",
		server: { publish() {} },
		plan: {},
		config: {},
	} as unknown as Room;
	try {
		let result = await opened.value.stream("Read codebase-memory", controller.signal);
		for await (let part of result.fullStream) translate(context, part);
		expect(controller.signal.aborted).toBe(false);
		expect(chat.interruption).toBeUndefined();
		expect(opened.value.activeTools).toContain("mcp__codebase_memory_mcp__list_projects");
		expect(chat.entries.flatMap(entry => entry.tools ?? [])).toContainEqual(
			expect.objectContaining({ name: "mcp__codebase_memory_mcp__list_projects", status: "done" }),
		);
		expect(chat.entries.some(entry => entry.text.includes("The graph query completed."))).toBe(
			true,
		);
	} finally {
		await opened.value.destroy();
	}
});

function fixture(fake = new Fake(), directory?: string, mcpFactory = async () => EMPTY_MCP) {
	directory ??= mkdtempSync(join(tmpdir(), "chopin-codex-test-"));
	directories.push(directory);
	let approvals: string[] = [];
	let harness = createCodexAdapter({
		connect: () => fake,
		mcpFactory,
		stateDirectory: directory,
		repositories: [{ id: "repo", name: "local/project", path: directory }],
		resolve: sessionId => ({
			channelId: sessionId,
			repositoryId: "repo",
			humanInput: {
				questionnaire: async (params: { questions: { question: string }[] }) => {
					approvals.push(...params.questions.map(question => question.question));
					return {
						cancelled: false,
						answers: params.questions.map((_, questionIndex) => ({
							questionIndex,
							kind: "option",
							answer: "Approve once",
						})),
					};
				},
				confirm: async (title: string) => {
					approvals.push(title);
					return true;
				},
			},
		} as unknown as CodexPlanner),
	});
	harnesses.push(harness);
	return { harness, fake, directory, approvals };
}

const start = (
	sessionId: string,
) => ({ sessionId } as Parameters<ReturnType<typeof createCodexAdapter>["doStart"]>[0]);

it("workers are ephemeral, keep the selected model and reasoning, and write only their copy", async () => {
	let fake = new Fake();
	let base = fixture(fake);
	let harness = createCodexAdapter({
		connect: () => fake,
		mcpFactory: async () => EMPTY_MCP,
		stateDirectory: base.directory,
		repositories: [{ id: "repo", name: "local/test", path: "/original" }],
		resolve: () => ({
			channelId: "worker",
			repositoryId: "repo",
			cwd: base.directory,
			writable: true,
			ephemeral: true,
			nativeTools: false,
			humanInput: {},
		} as CodexPlanner),
	});
	harnesses.push(harness);
	let session = await harness.doStart(start("worker"));
	let control = await session.doPromptTurn(
		turn({
			model: "chosen-sol",
			thinkingLevel: "high",
			responseFormat: { type: "json", schema: { type: "object" } },
		}),
	);
	let request = fake.calls.find(call => call.method === "thread/start")!.params;
	expect(request).toMatchObject({
		cwd: base.directory,
		ephemeral: true,
		sandbox: "workspace-write",
		model: "chosen-sol",
	});
	expect(request.config["features.shell_tool"]).toBe(false);
	expect(request.config["sandbox_workspace_write.writable_roots"]).toEqual([base.directory]);
	expect(fake.calls.find(call => call.method === "turn/start")!.params).toMatchObject({
		model: "chosen-sol",
		effort: "high",
		outputSchema: { type: "object" },
		sandboxPolicy: { writableRoots: [base.directory], networkAccess: false, excludeSlashTmp: true },
	});
	fake.complete("thread-1");
	await control.done;
	await session.doDestroy();
	expect(fake.calls.some(call => call.method === "thread/archive")).toBe(true);
});
function turn(extra: Partial<PlannerTurn> = {}): PlannerTurn {
	return {
		prompt: "Read the document",
		tools: [],
		instructions: "Only this document",
		skills: [],
		permissionMode: "allow-reads",
		emit() {},
		...extra,
	} as PlannerTurn;
}

it("bridges a real HarnessAgent host tool and streamed reply without executing inherited MCP tools", async () => {
	let h = fixture();
	h.fake.auto = true;
	let reads = 0;
	let agent = new HarnessAgent({
		harness: h.harness,
		activeTools: ["read_plan"],
		tools: {
			read_plan: tool({
				inputSchema: z.object({}),
				execute: async () => {
					reads++;
					return "# Current document";
				},
			}),
		},
	});
	let session = await agent.createSession({
		sessionId: "document",
		sandboxSession: {
			defaultWorkingDirectory: h.directory,
			run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
			destroy: async () => {},
		} as never,
	});
	let result = await agent.generate({ session, prompt: "Read my document" });
	expect(result.text).toBe("I read the document.");
	expect(reads).toBe(1);
	expect(h.fake.replies[0]!.result).toMatchObject({
		success: true,
		contentItems: [{ text: "# Current document" }],
	});
	let request = h.fake.calls.find(call => call.method === "thread/start")!.params;
	expect(request.config.mcp_servers).toEqual({ push_capable: { enabled: false } });
	expect(request.dynamicTools.map((spec: { name: string }) => spec.name)).toEqual(["read_plan"]);
	await session.destroy();
});

it("keeps documents isolated and resumes the same document's thread after process restart", async () => {
	let h = fixture();
	let first = await h.harness.doStart(start("one"));
	let a = await first.doPromptTurn(turn({ model: "my-model", thinkingLevel: "high" }));
	h.fake.complete("thread-1");
	await a.done;
	await first.doDestroy();
	let second = await h.harness.doStart(start("two"));
	let b = await second.doPromptTurn(turn());
	h.fake.complete("thread-2");
	await b.done;
	await second.doDestroy();
	await h.harness.shutdown();
	let resumed = fixture(new Fake(), h.directory);
	let reopened = await resumed.harness.doStart(start("one"));
	let c = await reopened.doPromptTurn(turn());
	resumed.fake.complete("thread-1");
	await c.done;
	expect(resumed.fake.calls.find(call => call.method === "thread/resume")!.params.threadId).toBe(
		"thread-1",
	);
	expect(resumed.fake.calls.some(call => call.method === "thread/start")).toBe(false);
	expect(h.fake.calls.find(call => call.method === "turn/start")!.params).toMatchObject({
		model: "my-model",
		effort: "high",
		sandboxPolicy: CODEX_SANDBOX,
		approvalPolicy: CODEX_APPROVALS,
	});
});

it("refuses a missing ChatGPT login or a weakened sandbox before sending a prompt", async () => {
	let loggedOut = fixture();
	loggedOut.fake.account = "apiKey";
	await expect(loggedOut.harness.doStart(start("one"))).rejects.toThrow("Sign in to Codex");
	let unsafe = fixture();
	unsafe.fake.unsafe = true;
	let session = await unsafe.harness.doStart(start("one"));
	await expect(session.doPromptTurn(turn())).rejects.toThrow("did not accept");
	expect(unsafe.fake.calls.some(call => call.method === "turn/start")).toBe(false);
});

it("asks inside Chopin for command approval, refuses network and file permissions, and rejects unknown host tools", async () => {
	let h = fixture();
	let session = await h.harness.doStart(start("one"));
	let active = await session.doPromptTurn(turn());
	let request = (id: number, method: string, params = {}) =>
		h.fake.emit({ id, method, params: { threadId: "thread-1", ...params } });
	request(1, "item/commandExecution/requestApproval", { command: "rg source" });
	await Bun.sleep(0);
	expect(h.approvals).toHaveLength(1);
	expect(h.fake.replies.find(reply => reply.id === 1)!.result).toEqual({ decision: "accept" });
	request(2, "item/commandExecution/requestApproval", {
		command: "git push",
		networkApprovalContext: { host: "gitlab.test" },
	});
	request(3, "item/permissions/requestApproval", { permissions: { network: { enabled: true } } });
	request(4, "item/fileChange/requestApproval");
	request(5, "item/tool/call", { tool: "push_code", callId: "push", arguments: {} });
	expect(h.approvals).toHaveLength(1);
	expect(h.fake.replies.find(reply => reply.id === 2)!.result).toEqual({ decision: "decline" });
	expect(h.fake.replies.find(reply => reply.id === 3)!.result).toEqual({
		permissions: {},
		scope: "turn",
	});
	expect(h.fake.replies.find(reply => reply.id === 4)!.result).toEqual({ decision: "decline" });
	expect(h.fake.replies.find(reply => reply.id === 5)!.result.success).toBe(false);
	h.fake.complete("thread-1");
	await active.done;
});

it("interrupts on Stop and reports a lost process without replaying the prompt", async () => {
	let h = fixture();
	let session = await h.harness.doStart(start("one"));
	let controller = new AbortController();
	let active = await session.doPromptTurn(turn({ abortSignal: controller.signal }));
	controller.abort();
	await active.done;
	expect(h.fake.calls.filter(call => call.method === "turn/interrupt")).toHaveLength(1);
	let next = await session.doPromptTurn(turn());
	h.fake.close();
	await expect(Promise.resolve(next.done)).rejects.toThrow("Interrupted work is not replayed");
	expect(h.fake.calls.filter(call => call.method === "turn/start")).toHaveLength(2);
});

it("loads confined MCP tools into the same conversation each turn and waits for a human approval", async () => {
	let closed = 0;
	let fake = new Fake();
	fake.inventory = name =>
		name === "confined"
			? [{ name, runtimeStatus: "connected", tools: { execute: {} } }]
			: [{ name, runtimeStatus: "disabled", tools: {} }];
	let h = fixture(
		fake,
		undefined,
		async () => ({
			servers: { confined: { command: "confined-launcher" } },
			tools: { confined: ["execute"] },
			instructions: "Confined tools",
			close: async () => {
				closed++;
			},
		}),
	);
	let session = await h.harness.doStart(start("mcp-document"));
	let active = await session.doPromptTurn(turn());
	let config = fake.calls.find(call => call.method === "thread/start")!.params.config;
	expect(config.mcp_servers).toMatchObject({
		push_capable: { enabled: false },
		confined: { command: "confined-launcher" },
	});
	fake.emit({
		id: 123,
		method: "tool/requestUserInput",
		params: {
			threadId: "thread-1",
			turnId: "turn-1",
			questions: [{
				id: "approval",
				header: "MCP",
				question: "Run confined execute?",
				options: [{ label: "Approve once", description: "Run once" }, {
					label: "Deny",
					description: "Refuse",
				}],
			}],
		},
	});
	expect(fake.replies.find(reply => reply.id === 123)).toBeUndefined();
	await Bun.sleep(0);
	expect(h.approvals).toContain("Run confined execute?");
	expect(fake.replies.find(reply => reply.id === 123)!.result).toEqual({
		answers: { approval: { answers: ["Approve once"] } },
	});
	fake.complete("thread-1");
	await active.done;
	let next = await session.doPromptTurn(turn());
	expect(closed).toBe(1);
	expect(fake.calls.find(call => call.method === "thread/resume")!.params.threadId).toBe(
		"thread-1",
	);
	expect(
		fake.calls.filter(call => call.method === "mcpServerStatus/list").every(call =>
			call.params.serverName && call.params.threadId === "thread-1"
		),
	).toBe(true);
	fake.complete("thread-1");
	await next.done;
	await session.doDestroy();
	expect(closed).toBe(2);
});

it("refuses unexpected MCP tools before generating and closes their launchers", async () => {
	let closed = false;
	let fake = new Fake();
	fake.inventory = name => [{ name, runtimeStatus: "connected", tools: { surprise: {} } }];
	let h = fixture(
		fake,
		undefined,
		async () => ({
			servers: { confined: {} },
			tools: { confined: ["read"] },
			instructions: "",
			close: async () => {
				closed = true;
			},
		}),
	);
	let session = await h.harness.doStart(start("refused-mcp"));
	await expect(session.doPromptTurn(turn())).rejects.toThrow("unexpected MCP");
	expect(fake.calls.some(call => call.method === "turn/start")).toBe(false);
	expect(closed).toBe(true);
	expect(fake.calls.some(call => call.method === "thread/unsubscribe")).toBe(true);
});

it("revokes previous MCP activity names when a later turn has no native tools", async () => {
	let directory = mkdtempSync(join(tmpdir(), "chopin-codex-catalog-"));
	directories.push(directory);
	let fake = new Fake();
	let planner = { channelId: "catalog", repositoryId: "repo", humanInput: {} } as CodexPlanner;
	let enabled = true;
	fake.inventory = name =>
		name === "confined"
			? [{ name, runtimeStatus: "connected", tools: { read: {} } }]
			: [{ name, runtimeStatus: "disabled", tools: {} }];
	let harness = createCodexAdapter({
		connect: () => fake,
		resolve: () => planner,
		stateDirectory: directory,
		repositories: [{ id: "repo", name: "local/project", path: directory }],
		mcpFactory: async () =>
			enabled
				? {
					servers: { confined: {} },
					tools: { confined: ["read"] },
					instructions: "",
					close: async () => {},
				}
				: EMPTY_MCP,
	});
	harnesses.push(harness);
	let session = await harness.doStart(start("catalog"));
	let first = await session.doPromptTurn(turn());
	expect(planner.activeTools).toContain("mcp__confined__read");
	fake.complete("thread-1");
	await first.done;
	enabled = false;
	let next = await session.doPromptTurn(turn());
	expect(planner.activeTools).not.toContain("mcp__confined__read");
	fake.emit({
		method: "item/started",
		params: {
			threadId: "thread-1",
			turnId: "turn-2",
			item: { type: "mcpToolCall", id: "removed", server: "confined", tool: "read", arguments: {} },
		},
	});
	await expect(Promise.resolve(next.done)).rejects.toThrow("outside the verified turn catalog");
	await session.doDestroy();
	expect(planner.activeTools).toBeUndefined();
});
