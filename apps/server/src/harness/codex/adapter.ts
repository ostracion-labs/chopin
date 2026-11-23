import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { type CodexPlanner, codexPlanner } from "./registry";
import { type CodexRpc, type Message, Rpc } from "./rpc";
import { workspaceRepositories } from "../../workspace/config";
import { type ConfiguredMcp, openConfiguredMcp } from "./mcp";
import { mcpInput } from "./mcp-input";

import type { HarnessV1, HarnessV1PromptControl, HarnessV1Session } from "@ai-sdk/harness";
import type { Chat as Wire } from "@chopin/protocol";
import type { PlannerTurn } from "../turn-level";
import type { WorkspaceRepository } from "../../workspace/config";

/** Approvals for sandboxed commands only. No approval can remove the sandbox or grant a network. */
export const CODEX_APPROVALS = {
	granular: {
		sandbox_approval: false,
		rules: true,
		skill_approval: false,
		request_permissions: false,
		mcp_elicitations: true,
	},
};
export const CODEX_SANDBOX = { type: "readOnly", networkAccess: false };

const USAGE = {
	inputTokens: {
		total: undefined,
		noCache: undefined,
		cacheRead: undefined,
		cacheWrite: undefined,
	},
	outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

const mcpToolName = (server: string, tool: string) =>
	`mcp__${server.replaceAll("-", "_")}__${tool}`;

export type CodexSettings = {
	connect?: () => CodexRpc;
	resolve?: (sessionId: string) => CodexPlanner;
	repositories?: WorkspaceRepository[];
	stateDirectory?: string;
	command?: string[];
	accountType?: string;
	defaultModel?: string;
	defaultThinkingLevel?: string;
	mcpFactory?: typeof openConfiguredMcp;
};

/** Codex owns login tokens and refresh. Chopin never reads, copies or stores them. */
export function createCodexAdapter(settings: CodexSettings = {}): HarnessV1 & {
	shutdown(): Promise<void>;
	catalog(model?: string): Promise<Wire.ModelCatalog>;
} {
	let directory = settings.stateDirectory ?? process.env.CHOPIN_CODEX_STATE_DIR
		?? join(
			process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
			"chopin",
			"workspace",
			"codex",
		);
	let repositories = () =>
		settings.repositories ?? workspaceRepositories(process.env.CHOPIN_WORKSPACES);
	let opening: Promise<{ rpc: CodexRpc; config: Record<string, any> }> | undefined;
	let currentRpc: CodexRpc | undefined;
	let shuttingDown = false;
	let sessions = new Set<() => Promise<void>>();
	let busy = new Set<string>();

	async function connection() {
		return opening ??= (async () => {
			let command = settings.command ?? [process.env.CHOPIN_CODEX_COMMAND || "codex"];
			let scratch = settings.connect ? undefined : await mkdtemp(join(directory, "runtime-"));
			let rpc = settings.connect?.() ?? new Rpc(command[0]!, [
				...command.slice(1),
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
				"features.browser_use=false",
				"-c",
				"features.code_mode=false",
				"-c",
				"features.skill_mcp_dependency_install=false",
				"-c",
				"features.remote_plugin=false",
				"-c",
				"features.computer_use=false",
				"-c",
				'web_search="disabled"',
			], scratch!);
			currentRpc = rpc;
			void rpc.closed.then(() => {
				if (scratch) void rm(scratch, { recursive: true, force: true }).catch(() => {});
				if (currentRpc === rpc) {
					opening = undefined;
					currentRpc = undefined;
				}
			});
			try {
				await rpc.request("initialize", {
					clientInfo: { name: "chopin_local", title: "Chopin", version: "1.0.0" },
					capabilities: { experimentalApi: true },
				});
				rpc.notify("initialized");
				let account = await rpc.request("account/read", { refreshToken: false });
				if (account.account?.type !== (settings.accountType ?? "chatgpt")) {
					throw new Error(
						"Sign in to Codex with your ChatGPT account first (codex login), then send your message again.",
					);
				}
				let { config } = await rpc.request("config/read", { includeLayers: false });
				return { rpc, config };
			} catch (error) {
				rpc.close();
				opening = undefined;
				throw error;
			}
		})();
	}

	async function ready() {
		if (shuttingDown) throw new Error("Codex is shutting down.");
		await mkdir(directory, { recursive: true, mode: 0o700 });
		return connection();
	}

	return {
		specificationVersion: "harness-v1",
		harnessId: "codex",
		builtinTools: {},
		supportsBuiltinToolFiltering: true,
		async catalog(operatorModel) {
			let { rpc, config } = await ready();
			let models: Record<string, any>[] = [];
			let cursor: string | undefined;
			do {
				let page = await rpc.request("model/list", { ...(cursor ? { cursor } : {}), limit: 100 });
				models.push(...page.data.filter((model: Record<string, any>) => !model.hidden));
				cursor = page.nextCursor ?? undefined;
			} while (cursor);
			let model = operatorModel || settings.defaultModel || config.model
				|| models.find(item => item.isDefault)?.model;
			return {
				models: models.map(item => ({
					id: item.model,
					name: item.displayName,
					description: item.description,
					thinkingLevels: item.supportedReasoningEfforts.map((level: Record<string, any>) =>
						level.reasoningEffort
					),
				})),
				...(model
					? {
						default: {
							model,
							...(config.model_reasoning_effort
								? { thinkingLevel: config.model_reasoning_effort }
								: {}),
						},
					}
					: {}),
			};
		},
		async doStart(start): Promise<HarnessV1Session> {
			let planner = (settings.resolve ?? codexPlanner)(start.sessionId);
			let checkout = repositories().find(item => item.id === planner.repositoryId);
			if (!checkout) throw new Error("The document's local checkout is no longer registered.");
			let source = checkout.path;
			let { rpc, config } = await ready();
			let cwd = planner.cwd ?? source;
			let policy = planner.writable
				? {
					type: "workspaceWrite",
					writableRoots: [cwd],
					networkAccess: false,
					excludeTmpdirEnvVar: true,
					excludeSlashTmp: true,
				}
				: CODEX_SANDBOX;
			let key = createHash("sha256").update(planner.channelId).digest("hex");
			let file = join(directory, key + ".json");
			let threadId: string | undefined;
			let active: { control: HarnessV1PromptControl; stop: () => Promise<void> } | undefined;
			let closed = false;
			let mcp: ConfiguredMcp | undefined;
			// Inherited host processes are replaced by confined MCP launchers before any model turn.
			// The classifier has no MCP tools. Other native integrations remain disabled.
			let overrides = {
				mcp_servers: Object.fromEntries(
					Object.keys(config.mcp_servers ?? {}).map(name => [name, { enabled: false }]),
				),
				"features.apps": false,
				"features.plugins": false,
				"features.hooks": false,
				"features.multi_agent": false,
				"features.browser_use": false,
				"features.computer_use": false,
				"features.code_mode": false,
				"features.code_mode_host": planner.nativeTools !== false,
				"features.skill_mcp_dependency_install": false,
				"features.remote_plugin": false,
				...(planner.nativeTools === false
					? { "features.shell_tool": false, "features.unified_exec": false }
					: {}),
				web_search: "disabled",
				"sandbox_read_only.network_access": false,
				"sandbox_workspace_write.network_access": false,
				"sandbox_workspace_write.writable_roots": planner.writable ? [cwd] : [],
				"sandbox_workspace_write.exclude_tmpdir_env_var": true,
				"sandbox_workspace_write.exclude_slash_tmp": true,
			};

			async function prompt(turn: PlannerTurn): Promise<HarnessV1PromptControl> {
				if (closed || active || busy.has(planner.channelId)) {
					throw new Error("This document's Codex conversation is already running or closed.");
				}
				turn.abortSignal?.throwIfAborted();
				busy.add(planner.channelId);
				planner.activeTools = undefined;
				try {
					{
						if (mcp) {
							if (threadId && Object.keys(mcp.servers).length) {
								await rpc.request("thread/unsubscribe", { threadId });
							}
							await mcp.close();
							mcp = undefined;
						}
						let effective = await rpc.request("config/read", { includeLayers: false, cwd: source });
						mcp = await (settings.mcpFactory ?? openConfiguredMcp)(
							rpc,
							effective.config ?? config,
							{
								directory,
								planner,
								source,
								repositories: repositories().map(item => item.path),
								signal: turn.abortSignal ?? new AbortController().signal,
							},
						);
						let saved: { threadId: string } | undefined = threadId ? { threadId } : undefined;
						try {
							saved ??= JSON.parse(await readFile(file, "utf8"));
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
						}
						let params = {
							cwd,
							sandbox: planner.writable ? "workspace-write" : "read-only",
							approvalPolicy: CODEX_APPROVALS,
							approvalsReviewer: "user",
							config: {
								...overrides,
								mcp_servers: {
									...overrides.mcp_servers,
									...Object.fromEntries(
										Object.keys(effective.config?.mcp_servers ?? {}).map(
											name => [name, { enabled: false }],
										),
									),
									...mcp.servers,
								},
							},
							...((turn.model || settings.defaultModel)
								? { model: turn.model || settings.defaultModel }
								: {}),
							ephemeral: planner.ephemeral ?? false,
							developerInstructions: [turn.instructions, mcp.instructions].filter(Boolean).join(
								"\n\n",
							),
							dynamicTools: turn.tools.map(spec => ({
								type: "function",
								name: spec.name,
								description: spec.description ?? spec.name,
								inputSchema: spec.inputSchema ?? { type: "object", properties: {} },
							})),
						};
						if (planner.ephemeral) saved = undefined;
						let response = saved
							? await rpc.request("thread/resume", {
								...params,
								threadId: saved.threadId,
								excludeTurns: true,
							})
							: await rpc.request("thread/start", { ...params, allowProviderModelFallback: false });
						if (
							response.sandbox?.type !== policy.type || response.sandbox.networkAccess !== false
							|| planner.writable
								&& (response.cwd !== cwd || !Array.isArray(response.sandbox.writableRoots)
									|| response.sandbox.writableRoots.some((root: string) => root !== cwd)
									|| response.sandbox.excludeSlashTmp !== true
									|| response.sandbox.excludeTmpdirEnvVar !== true)
							|| response.approvalPolicy?.granular?.sandbox_approval !== false
							|| response.approvalPolicy?.granular?.request_permissions !== false
							|| response.approvalsReviewer !== "user"
							|| response.modelProvider !== (settings.accountType === "acp" ? "acp" : "openai")
						) {
							throw new Error(
								"The AI did not accept Chopin's filesystem policy and human approvals. The turn was not started.",
							);
						}
						threadId = response.thread.id;
						// Name the server as well as the thread: an unscoped inventory can inspect the
						// app-server's global MCP connections instead of this confined thread's tools.
						let nativeNames: string[] = [];
						for (let name of Object.keys(params.config.mcp_servers)) {
							let inventory = await rpc.request("mcpServerStatus/list", {
								threadId,
								serverName: name,
								limit: 100,
								detail: "toolsAndAuthOnly",
							});
							if (
								inventory.nextCursor || !Array.isArray(inventory.data)
								|| inventory.data.some((server: Record<string, any>) => {
									let names = mcp!.tools[server.name];
									return server.name !== name || (names
										? Object.keys(server.tools ?? {}).some(tool => !names.includes(tool))
											|| ["failed", "disabled"].includes(server.runtimeStatus)
										: server.runtimeStatus !== "disabled"
											|| Object.keys(server.tools ?? {}).length);
								}) || mcp.tools[name] && !inventory.data.some((server: Record<string, any>) =>
										server.name === name
									)
							) {
								throw new Error(
									"Codex exposed an unavailable or unexpected MCP tool. The turn was not started.",
								);
							}
							for (let server of inventory.data) {
								nativeNames.push(
									...Object.keys(server.tools ?? {}).map(tool => mcpToolName(name, tool)),
								);
							}
						}
						if (!saved && !planner.ephemeral) {
							let temporary = file + "." + crypto.randomUUID();
							await writeFile(temporary, JSON.stringify({ threadId }), { mode: 0o600 });
							await rename(temporary, file);
						}
						turn.abortSignal?.throwIfAborted();
						planner.activeTools = [
							...new Set([...turn.tools.map(tool => tool.name), ...nativeNames]),
						];
					}
				} catch (error) {
					planner.activeTools = undefined;
					if (threadId) await rpc.request("thread/unsubscribe", { threadId }).catch(() => {});
					await mcp?.close();
					mcp = undefined;
					busy.delete(planner.channelId);
					throw error;
				}
				let resolve!: () => void;
				let reject!: (error: Error) => void;
				let done = new Promise<void>((yes, no) => {
					resolve = yes;
					reject = no;
				});
				void done.catch(() => {});
				let turnId: string | undefined;
				let ended = false;
				let text = new Set<string>();
				let calls = new Map<string, { requestId: number | string; name: string }>();
				let mcpCalls = new Set<string>();
				let controller = new AbortController();
				let stopTimer: ReturnType<typeof setTimeout> | undefined;
				const signal = turn.abortSignal
					? AbortSignal.any([turn.abortSignal, controller.signal])
					: controller.signal;
				const finish = (error?: Error) => {
					if (ended) return;
					ended = true;
					controller.abort();
					for (let id of text) turn.emit({ type: "text-end", id });
					text.clear();
					unwatch();
					turn.abortSignal?.removeEventListener("abort", abort);
					if (stopTimer) clearTimeout(stopTimer);
					busy.delete(planner.channelId);
					active = undefined;
					if (error) {
						turn.emit({ type: "error", error });
						reject(error);
					} else {
						turn.emit({
							type: "finish-step",
							finishReason: { unified: "stop", raw: "completed" },
							usage: USAGE,
						});
						turn.emit({
							type: "finish",
							finishReason: { unified: "stop", raw: "completed" },
							totalUsage: USAGE,
						});
						resolve();
					}
				};
				const stop = async () => {
					if (ended) return;
					controller.abort();
					stopTimer ??= setTimeout(() => {
						rpc.close();
						finish();
					}, 5000);
					if (turnId) {
						await rpc.request("turn/interrupt", { threadId, turnId }).catch(() => {
							rpc.close();
							finish();
						});
					}
				};
				const abort = () => {
					void stop();
				};
				const respond = (id: number | string, value: unknown) => {
					if (!ended) rpc.reply(id, value);
				};
				const handle = async (message: Message) => {
					if (message.method === "chopin/disconnected") {
						finish(
							new Error(
								"Codex disconnected. Interrupted work is not replayed; send a new message to continue.",
							),
						);
						return;
					}
					let params = message.params ?? {};
					if (
						params.threadId !== threadId || ended
						|| (turnId && params.turnId && params.turnId !== turnId)
					) return;
					if (message.id !== undefined) {
						let id = message.id;
						if (message.method === "item/tool/call") {
							let name = String(params.tool);
							let callId = String(params.callId);
							if (!turn.tools.some(spec => spec.name === name) || calls.has(callId)) {
								respond(id, {
									success: false,
									contentItems: [{
										type: "inputText",
										text: "This tool is unavailable in local workspace mode.",
									}],
								});
								return;
							}
							calls.set(callId, { requestId: id, name });
							turn.emit({
								type: "tool-call",
								toolCallId: callId,
								toolName: name,
								input: JSON.stringify(params.arguments),
							});
						} else if (message.method === "item/commandExecution/requestApproval") {
							if (params.networkApprovalContext || params.proposedNetworkPolicyAmendments) {
								respond(id, { decision: "decline" });
								return;
							}
							let approved = await planner.humanInput.confirm(
								"Run this sandboxed command?",
								[params.command, params.cwd, params.reason].filter(Boolean).join("\n\n"),
								{ signal, sessionId: start.sessionId, requestId: String(id) },
							);
							respond(id, { decision: approved && !signal.aborted ? "accept" : "decline" });
						} else if (
							message.method === "item/tool/requestUserInput"
							|| message.method === "tool/requestUserInput"
						) {
							let questions = params.questions as {
								id: string;
								header: string;
								question: string;
								options?: { label: string; description: string }[];
							}[];
							let result = await planner.humanInput.questionnaire({
								questions: questions.map(question => ({
									...question,
									options: question.options ?? [],
								})),
							}, { signal, sessionId: start.sessionId, requestId: String(id) });
							respond(id, {
								answers: Object.fromEntries(questions.map((question, i) => {
									let answer = result.answers.find(item => item.questionIndex === i);
									return [question.id, {
										answers: answer?.kind === "multi"
											? answer.selected
											: answer?.answer
											? [answer.answer]
											: [],
									}];
								})),
							});
						} else if (message.method === "mcpServer/elicitation/request") {
							respond(
								id,
								mcp?.servers[String(params.serverName)]
									? await mcpInput(params, planner.humanInput, signal, start.sessionId, String(id))
									: { action: "decline", content: null },
							);
						} else if (message.method === "item/permissions/requestApproval") {
							respond(id, { permissions: {}, scope: "turn" });
						} else if (message.method === "item/fileChange/requestApproval") {
							respond(id, { decision: "decline" });
						} else {
							respond(id, { decision: "decline" });
							throw new Error(`Codex requested an unsupported action: ${message.method}.`);
						}
					} else if (
						(message.method === "item/started" || message.method === "item/completed")
						&& (params.item as Record<string, any>)?.type === "mcpToolCall"
					) {
						let item = params.item as Record<string, any>;
						let own = {
							toolCallId: String(item.id),
							toolName: mcpToolName(String(item.server), String(item.tool)),
						};
						if (!planner.activeTools?.includes(own.toolName)) {
							throw new Error("Codex reported an MCP tool outside the verified turn catalog.");
						}
						if (message.method === "item/started" && !mcpCalls.has(own.toolCallId)) {
							mcpCalls.add(own.toolCallId);
							turn.emit({
								type: "tool-call",
								...own,
								input: JSON.stringify(item.arguments ?? {}),
								providerExecuted: true,
								dynamic: true,
							});
						} else if (message.method === "item/completed") {
							turn.emit({
								type: "tool-result",
								...own,
								result: JSON.stringify(item.result ?? item.error ?? null),
								isError: !!item.error || item.result?.isError === true,
								dynamic: true,
							});
						}
					} else if (message.method === "item/agentMessage/delta") {
						let id = String(params.itemId);
						if (!text.has(id)) {
							text.add(id);
							turn.emit({ type: "text-start", id });
						}
						turn.emit({ type: "text-delta", id, delta: String(params.delta) });
					} else if (message.method === "item/completed") {
						let item = params.item as { id: string; type: string; text?: string };
						if (item.type === "agentMessage") {
							if (!text.has(item.id) && item.text) {
								turn.emit({ type: "text-start", id: item.id });
								turn.emit({ type: "text-delta", id: item.id, delta: item.text });
							}
							turn.emit({ type: "text-end", id: item.id });
							text.delete(item.id);
						}
					} else if (message.method === "turn/completed") {
						let outcome = params.turn as { status: string; error?: { message: string } };
						finish(
							outcome.status === "failed"
								? new Error(outcome.error?.message ?? "Codex could not finish the reply.")
								: undefined,
						);
					} else if (message.method === "error" && !params.willRetry) {
						finish(new Error((params.error as { message?: string })?.message ?? "Codex failed."));
					}
				};
				let unwatch = rpc.watch(message => {
					void handle(message).catch(error => {
						finish(error);
						rpc.close();
					});
				});
				let control: HarnessV1PromptControl = {
					done,
					async submitToolResult({ toolCallId, output, isError }) {
						let call = calls.get(toolCallId);
						if (!call || ended || signal.aborted) return;
						calls.delete(toolCallId);
						turn.emit({
							type: "tool-result",
							toolCallId,
							toolName: call.name,
							result: JSON.parse(JSON.stringify(output ?? "")),
							isError,
						});
						respond(call.requestId, {
							success: !isError,
							contentItems: [{
								type: "inputText",
								text: typeof output === "string" ? output : JSON.stringify(output ?? null),
							}],
						});
					},
				};
				active = { control, stop };
				turn.abortSignal?.addEventListener("abort", abort, { once: true });
				turn.emit({ type: "stream-start" });
				try {
					let content = typeof turn.prompt === "string" ? turn.prompt : turn.prompt.content;
					let value = typeof content === "string" ? content : content.map(part => {
						if (part.type !== "text") {
							throw new Error("Codex currently accepts text prompts in Chopin.");
						}
						return part.text;
					}).join("\n\n");
					let response = await rpc.request("turn/start", {
						threadId,
						input: [{ type: "text", text: value }],
						approvalPolicy: CODEX_APPROVALS,
						approvalsReviewer: "user",
						sandboxPolicy: policy,
						...((turn.model || settings.defaultModel)
							? { model: turn.model || settings.defaultModel }
							: {}),
						effort: turn.thinkingLevel ?? settings.defaultThinkingLevel ?? null,
						...(turn.responseFormat?.type === "json"
							? { outputSchema: turn.responseFormat.schema }
							: {}),
					});
					turnId = response.turn.id;
					if (signal.aborted) await stop();
				} catch (error) {
					finish(error instanceof Error ? error : new Error(String(error)));
				}
				return control;
			}
			const destroy = async () => {
				closed = true;
				if (active) {
					await active.stop();
					await active.control.done;
				}
				if (threadId && (planner.ephemeral || settings.accountType === "acp")) {
					await rpc.request("thread/archive", { threadId }).catch(() => {});
				}
				if (mcp) {
					if (threadId && Object.keys(mcp.servers).length) {
						await rpc.request("thread/unsubscribe", { threadId }).catch(() => {});
					}
					await mcp.close();
					mcp = undefined;
				}
				planner.activeTools = undefined;
				sessions.delete(destroy);
			};
			sessions.add(destroy);
			return {
				sessionId: start.sessionId,
				isResume: false,
				doPromptTurn: prompt,
				doContinueTurn: async () => {
					if (!active) throw new Error("No Codex turn to continue.");
					return active.control;
				},
				doDestroy: destroy,
				doCompact: async () => {
					throw new Error("Codex manages its own conversation compaction.");
				},
				doSuspendTurn: async () => {
					throw new Error("Stop the Codex turn instead of suspending it.");
				},
				doDetach: async () => {
					await destroy();
					return {
						type: "resume-session",
						harnessId: "codex",
						specificationVersion: "harness-v1",
						data: {},
					};
				},
				doStop: async () => {
					await destroy();
					return {
						type: "resume-session",
						harnessId: "codex",
						specificationVersion: "harness-v1",
						data: {},
					};
				},
			};
		},
		async shutdown() {
			shuttingDown = true;
			await Promise.allSettled([...sessions].map(close => close()));
			let live = opening;
			opening = undefined;
			if (live) (await live.catch(() => undefined))?.rpc.close();
		},
	};
}

/** Resetting a document's Planner starts a new conversation on the next request. */
export async function resetCodexConversation(
	channelId: string,
	stateDirectory?: string,
): Promise<void> {
	let directory = stateDirectory ?? process.env.CHOPIN_CODEX_STATE_DIR
		?? join(
			process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
			"chopin",
			"workspace",
			"codex",
		);
	let key = createHash("sha256").update(channelId).digest("hex");
	await unlink(join(directory, key + ".json")).catch(error => {
		if (error.code !== "ENOENT") throw error;
	});
}
