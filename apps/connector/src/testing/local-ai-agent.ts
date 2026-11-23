/** Deterministic ACP peer; no model or repository tools. */
import { createInterface } from "node:readline";
let sessions = new Map<string, { model: string; thought: string; mcp: any[] }>();
let pending = new Map<number, (value: any) => void>();
let sequence = 100;
const send = (value: unknown) =>
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value as object }) + "\n");
const options = (session: { model: string; thought: string }) => [
	{
		id: "model",
		name: "Model",
		category: "model",
		type: "select",
		currentValue: session.model,
		options: [{ value: "sol", name: "Sol" }, { value: "luna", name: "Luna" }],
	},
	{
		id: "effort",
		name: "Thinking",
		category: "thought_level",
		type: "select",
		currentValue: session.thought,
		options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }],
	},
];
createInterface({ input: process.stdin }).on("line", line => {
	let { id, method, params = {}, result } = JSON.parse(line);
	if (!method) {
		let callback = pending.get(id);
		pending.delete(id);
		callback?.(result);
		return;
	}
	if (method === "initialize") {
		send({
			id,
			result: {
				protocolVersion: 1,
				agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } },
			},
		});
		return;
	}
	if (method === "session/new" || method === "session/load") {
		let sessionId = params.sessionId ?? crypto.randomUUID();
		let session = { model: "sol", thought: "low", mcp: params.mcpServers };
		sessions.set(sessionId, session);
		send({ id, result: { sessionId, configOptions: options(session) } });
		return;
	}
	let session = sessions.get(params.sessionId)!;
	if (method === "session/set_config_option") {
		if (params.configId === "model") session.model = params.value;
		else session.thought = params.value;
		send({ id, result: { configOptions: options(session) } });
		return;
	}
	if (method === "session/prompt") {
		let requestId = ++sequence;
		pending.set(requestId, async permission => {
			let toolResult = "no tools";
			if (session.mcp.length) {
				let server = session.mcp[0];
				let headers = Object.fromEntries(
					server.headers.map((item: any) => [item.name, item.value]),
				);
				let response = await fetch(server.url, {
					method: "POST",
					headers: { ...headers, "content-type": "application/json" },
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						method: "tools/call",
						params: { name: "read_plan", arguments: {} },
					}),
				});
				toolResult = JSON.stringify(await response.json());
			}
			send({
				method: "session/update",
				params: {
					sessionId: params.sessionId,
					update: {
						sessionUpdate: "agent_message_chunk",
						content: {
							type: "text",
							text:
								`${session.model}/${session.thought}: ${permission.outcome.outcome}. ${toolResult}`,
						},
					},
				},
			});
			send({ id, result: { stopReason: "end_turn" } });
		});
		send({
			id: requestId,
			method: "session/request_permission",
			params: {
				sessionId: params.sessionId,
				toolCall: { toolCallId: "test", title: "Test command", kind: "execute", status: "pending" },
				options: [{ optionId: "yes", name: "Allow once", kind: "allow_once" }, {
					optionId: "no",
					name: "Reject",
					kind: "reject_once",
				}],
			},
		});
	}
});
