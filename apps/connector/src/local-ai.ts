/** Private ACP <-> local harness bridge. Agents always start through Sandbox. */
import { ClientApp } from "@agentclientprotocol/sdk";
import { createInterface } from "node:readline";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initialize, startAgent } from "./acp";
import type { Readable } from "node:stream";
import { createSandbox } from "./sandbox";
import type { AiConnection } from "@chopin/protocol/local-ai";

type Json = Record<string, any>;
type Session = {
	agent: ReturnType<typeof startAgent>;
	id: string;
	options: Json[];
	params: Json;
	token: string;
	turn?: string;
	writable: boolean;
};

export async function serveLocalAcp(
	connection: AiConnection,
	options: {
		input?: Readable;
		write?: (message: Json) => void;
		sandboxFactory?: typeof createSandbox;
	} = {},
) {
	const write = options.write ?? ((message: Json) => {
		process.stdout.write(JSON.stringify(message) + "\n");
	});
	let next = 0;
	let pending = new Map<
		number,
		{ resolve(value: Json): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
	>();
	let sessions = new Map<string, Session>();
	let tokens = new Map<string, Session>();
	let probe: Session | undefined;
	const request = (method: string, params: Json) =>
		new Promise<Json>((resolve, reject) => {
			let id = ++next;
			let timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error("Human approval or tool result timed out"));
			}, 20 * 60_000);
			pending.set(id, { resolve, reject, timer });
			write({ id, method, params });
		});
	// Each session sees only its host-provided tools. This endpoint never accepts the workspace key.
	let server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			let token = req.headers.get("authorization")?.replace(/^Bearer /i, "");
			let session = token ? tokens.get(token) : undefined;
			if (!session || req.method !== "POST" || req.headers.has("origin")) {
				return new Response(null, { status: 403 });
			}
			try {
				let raw = await req.text();
				if (raw.length > 128_000) {
					throw new Error("Request too large");
				}
				let message = JSON.parse(raw);
				let result: Json;
				if (message.method === "notifications/initialized") {
					return new Response(null, { status: 202 });
				}
				if (message.method === "initialize") {
					result = {
						protocolVersion: "2024-11-05",
						capabilities: { tools: {} },
						serverInfo: { name: "chopin-document", version: "1" },
					};
				} else if (message.method === "tools/list") {
					result = {
						tools: (session.params.dynamicTools ?? []).map((tool: Json) => ({
							name: tool.name,
							description: tool.description,
							inputSchema: tool.inputSchema,
						})),
					};
				} else if (message.method === "tools/call") {
					if (
						!session.turn
						|| !(session.params.dynamicTools ?? []).some((tool: Json) =>
							tool.name === message.params?.name
						)
					) throw new Error("Tool unavailable");
					let output = await request("item/tool/call", {
						threadId: session.id,
						turnId: session.turn,
						callId: crypto.randomUUID(),
						tool: message.params.name,
						arguments: message.params.arguments ?? {},
					});
					result = {
						isError: !output.success,
						content: (output.contentItems ?? []).map((item: Json) => ({
							type: "text",
							text: item.text,
						})),
					};
				} else throw new Error("Unsupported MCP method");
				return Response.json({ jsonrpc: "2.0", id: message.id, result });
			} catch (error) {
				return Response.json({
					jsonrpc: "2.0",
					id: null,
					error: { code: -32603, message: error instanceof Error ? error.message : "Tool failed" },
				});
			}
		},
	});
	let directory = await mkdtemp(join(tmpdir(), "chopin-acp-"));
	let sandbox = await (options.sandboxFactory ?? createSandbox)({
		directory,
		server: server.url.origin,
		hostsOnly: [`127.0.0.1:${server.port}`, ...connection.modelHosts],
		settings: { require: true },
	});
	if (sandbox.report.engine === "none") {
		server.stop(true);
		await sandbox.close();
		await rm(directory, { recursive: true, force: true });
		throw new Error(`ACP requires a working sandbox: ${sandbox.report.reason}`);
	}
	const flatOptions = (options: Json[]): Json[] =>
		options.flatMap(option => option.options ? flatOptions(option.options) : [option]);
	async function launch(params: Json, id?: string): Promise<Session> {
		let session: Session;
		let app = new ClientApp()
			.onNotification("session/update", ({ params: event }) => {
				if (!session?.turn) return; // Loading history is never replayed as a new reply.
				let update = event.update;
				if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
					write({
						method: "item/agentMessage/delta",
						params: {
							threadId: session.id,
							turnId: session.turn,
							itemId: session.turn,
							delta: update.content.text,
						},
					});
				}
			})
			.onRequest("session/request_permission", async ({ params: permission }) => {
				if (!session?.turn || params.config?.["features.shell_tool"] === false) {
					return { outcome: { outcome: "cancelled" as const } };
				}
				let approved = await request("item/commandExecution/requestApproval", {
					threadId: session.id,
					turnId: session.turn,
					command: permission.toolCall.title,
					cwd: params.cwd,
					reason: "The attached ACP agent requests this action within its sandbox.",
				});
				let option = permission.options.find(item => item.kind === "allow_once");
				return {
					outcome: approved.decision === "accept" && option
						? { outcome: "selected" as const, optionId: option.optionId }
						: { outcome: "cancelled" as const },
				};
			});
		let writable = params.sandbox === "workspace-write";
		let agent = startAgent(app, connection.command, params.cwd, process.env, undefined, {
			sandbox,
			...(writable ? { own: [params.cwd] } : {}),
		});
		try {
			let info = await initialize(agent.connection);
			if (!info.agentCapabilities?.mcpCapabilities?.http && params.dynamicTools?.length) {
				throw new Error("This ACP agent does not support HTTP MCP tools");
			}
			if (id && !info.agentCapabilities?.loadSession) {
				throw new Error(
					"This ACP agent cannot resume its saved conversation. Reset explicitly to start a new one.",
				);
			}
			let token = crypto.randomUUID();
			session = { agent, id: id ?? "", params, options: [], token, writable };
			tokens.set(token, session);
			let sessionParams = {
				cwd: params.cwd,
				mcpServers: params.dynamicTools?.length
					? [{
						type: "http" as const,
						name: "chopin-document",
						url: server.url.origin,
						headers: [{ name: "Authorization", value: `Bearer ${token}` }],
					}]
					: [],
			};
			let answer: Json = id
				? await agent.connection.agent.request("session/load", { ...sessionParams, sessionId: id })
				: await agent.connection.agent.request("session/new", sessionParams);
			session.id = id ?? answer.sessionId;
			session.options = answer.configOptions ?? [];
			// Older ACP agents expose the model selector through the experimental models field.
			if (!session.options.some(option => option.category === "model") && answer.models) {
				session.options.push({
					id: "__legacy_model",
					category: "model",
					options: answer.models.availableModels.map((model: Json) => ({
						value: model.modelId,
						name: model.name,
					})),
					currentValue: answer.models.currentModelId,
				});
			}
			return session;
		} catch (error) {
			await agent.stop();
			throw error;
		}
	}
	async function setOption(session: Session, category: string, value: string) {
		let option = session.options.find(item => item.category === category);
		if (!option || !flatOptions(option.options ?? []).some(item => item.value === value)) {
			throw new Error(`The ACP agent does not offer ${category}: ${value}`);
		}
		if (option.id === "__legacy_model") {
			await session.agent.connection.agent.request("session/set_model", {
				sessionId: session.id,
				modelId: value,
			});
		} else {
			let answer = await session.agent.connection.agent.request("session/set_config_option", {
				sessionId: session.id,
				configId: option.id,
				value,
			});
			session.options = (answer as Json).configOptions;
		}
	}
	async function handle(method: string, params: Json): Promise<Json> {
		if (method === "initialize") return { serverInfo: { name: "chopin-acp", version: "1" } };
		if (method === "account/read") return { account: { type: "acp" } };
		if (method === "config/read") return { config: {} };
		if (method === "mcpServerStatus/list") return { data: [], nextCursor: null };
		if (method === "model/list") {
			if (!probe) {
				let cwd = await mkdtemp(join(tmpdir(), "chopin-acp-catalog-"));
				probe = await launch({ cwd, dynamicTools: [], config: { "features.shell_tool": false } });
			}
			let selector = probe.options.find(item => item.category === "model");
			if (!selector) throw new Error("This ACP agent does not report a model catalog");
			let data = [];
			for (let option of flatOptions(selector.options ?? [])) {
				await setOption(probe, "model", option.value);
				let thought = probe.options.find(item => item.category === "thought_level");
				data.push({
					model: option.value,
					displayName: option.name ?? option.value,
					supportedReasoningEfforts: flatOptions(thought?.options ?? []).map(item => ({
						reasoningEffort: item.value,
					})),
					isDefault: selector.currentValue === option.value,
				});
			}
			return { data, nextCursor: null };
		}
		if (method === "thread/start" || method === "thread/resume") {
			let session = await launch(params, method === "thread/resume" ? params.threadId : undefined);
			sessions.set(session.id, session);
			return {
				thread: { id: session.id },
				cwd: session.params.cwd,
				modelProvider: "acp",
				approvalPolicy: params.approvalPolicy,
				approvalsReviewer: "user",
				sandbox: session.writable
					? {
						type: "workspaceWrite",
						writableRoots: [params.cwd],
						networkAccess: false,
						excludeSlashTmp: true,
						excludeTmpdirEnvVar: true,
					}
					: { type: "readOnly", networkAccess: false },
			};
		}
		let session = sessions.get(params.threadId);
		if (!session) throw new Error("ACP session unavailable");
		if (method === "turn/interrupt") {
			await session.agent.connection.agent.notify("session/cancel", { sessionId: session.id });
			return {};
		}
		if (method === "thread/archive") {
			tokens.delete(session.token);
			sessions.delete(session.id);
			await session.agent.stop();
			return {};
		}
		if (method === "turn/start") {
			if (session.turn) throw new Error("An ACP turn is already active");
			if (params.model) await setOption(session, "model", params.model);
			if (params.effort) await setOption(session, "thought_level", params.effort);
			let turn = crypto.randomUUID();
			session.turn = turn;
			let text = (params.input ?? []).map((item: Json) => item.text).join("\n\n");
			let prompt = `${session.params.developerInstructions ?? ""}\n\n${text}${
				params.outputSchema
					? `\n\nReturn only JSON conforming to this schema: ${JSON.stringify(params.outputSchema)}`
					: ""
			}`;
			void session.agent.connection.agent.request("session/prompt", {
				sessionId: session.id,
				prompt: [{ type: "text", text: prompt }],
			}).then(result => {
				session.turn = undefined;
				write({
					method: "turn/completed",
					params: {
						threadId: session.id,
						turn: {
							id: turn,
							status: result.stopReason === "cancelled" ? "interrupted" : "completed",
						},
					},
				});
			}, error => {
				session.turn = undefined;
				write({
					method: "turn/completed",
					params: {
						threadId: session.id,
						turn: {
							id: turn,
							status: "failed",
							error: { message: error instanceof Error ? error.message : "ACP prompt failed" },
						},
					},
				});
			});
			return { turn: { id: turn } };
		}
		throw new Error(`Unsupported bridge request: ${method}`);
	}
	let input = createInterface({ input: options.input ?? process.stdin });
	input.on("line", line => {
		if (line.length > 16 * 1024 * 1024) {
			input.close();
			return;
		}
		let message: Json;
		try {
			message = JSON.parse(line);
		} catch {
			input.close();
			return;
		}
		if (!message.method && message.id !== undefined) {
			let call = pending.get(Number(message.id));
			if (call) {
				clearTimeout(call.timer);
				pending.delete(Number(message.id));
				if (message.error) call.reject(new Error(message.error.message));
				else call.resolve(message.result);
			}
			return;
		}
		if (message.id === undefined) return;
		void handle(message.method, message.params ?? {}).then(
			result => write({ id: message.id, result }),
			error =>
				write({
					id: message.id,
					error: { message: error instanceof Error ? error.message : "ACP bridge failed" },
				}),
		);
	});
	let closing = false;
	let close = async () => {
		if (closing) return;
		closing = true;
		process.off("SIGTERM", terminated);
		for (let call of pending.values()) {
			clearTimeout(call.timer);
			call.reject(new Error("Bridge closed"));
		}
		await Promise.allSettled(
			[...sessions.values(), ...probe ? [probe] : []].map(session => session.agent.stop()),
		);
		await sandbox.close();
		server.stop(true);
		await rm(directory, { recursive: true, force: true });
		if (probe) await rm(probe.params.cwd, { recursive: true, force: true });
	};
	let terminated = () => {
		void close().finally(() => {
			if (!options.input) process.exit();
		});
	};
	process.once("SIGTERM", terminated);
	input.once("close", terminated);
	return close;
}

if (import.meta.main) {
	serveLocalAcp(JSON.parse(process.argv[2] ?? "null")).catch(error => {
		console.error(error instanceof Error ? error.message : "ACP bridge failed");
		process.exit(1);
	});
}
