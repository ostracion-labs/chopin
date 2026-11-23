/** A stdio Codex process for workspace integration tests. It never calls a model. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

let threads = new Map<string, number>();
let contexts = new Map<string, any>();
let checkpoints = new Map<string, string>();
let pending = new Map<number, (result: any) => void>();
let sequence = 100;
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
const call = (
	threadId: string,
	turnId: string,
	tool: string,
	args: unknown,
	next: (result: any) => void,
) => {
	let id = ++sequence;
	pending.set(id, next);
	send({
		id,
		method: "item/tool/call",
		params: { threadId, turnId, callId: String(id), tool, arguments: args },
	});
};
const finish = (threadId: string, turnId: string, text: string) => {
	send({
		method: "item/agentMessage/delta",
		params: { threadId, turnId, itemId: crypto.randomUUID(), delta: text },
	});
	send({
		method: "turn/completed",
		params: { threadId, turn: { id: turnId, status: "completed" } },
	});
};

createInterface({ input: process.stdin }).on("line", line => {
	let message = JSON.parse(line);
	if (!message.method) {
		let callback = pending.get(message.id);
		pending.delete(message.id);
		callback?.(message.result);
		return;
	}
	let { id, method, params = {} } = message;
	let result: unknown = {};
	if (method === "account/read") result = { account: { type: "chatgpt" } };
	if (method === "config/read") result = { config: { model: "codex-test" } };
	if (method === "mcpServerStatus/list") result = { data: [] };
	if (method === "model/list") {
		result = {
			data: ["codex-test", "codex-alternative"].map(model => ({
				model,
				displayName: model,
				description: "Test model",
				supportedReasoningEfforts: [{ reasoningEffort: "high" }],
				isDefault: model === "codex-test",
			})),
		};
	}
	if (method === "thread/start" || method === "thread/resume") {
		let threadId = params.threadId ?? crypto.randomUUID();
		threads.set(threadId, threads.get(threadId) ?? 0);
		contexts.set(threadId, params);
		result = {
			thread: { id: threadId },
			cwd: params.cwd,
			sandbox: params.sandbox === "workspace-write"
				? {
					type: "workspaceWrite",
					writableRoots: [],
					networkAccess: false,
					excludeSlashTmp: true,
					excludeTmpdirEnvVar: true,
				}
				: { type: "readOnly", networkAccess: false },
			approvalPolicy: params.approvalPolicy,
			approvalsReviewer: "user",
			modelProvider: "openai",
		};
	}
	if (method === "turn/interrupt") {
		send({
			method: "turn/completed",
			params: { threadId: params.threadId, turn: { id: params.turnId, status: "interrupted" } },
		});
	}
	if (method === "turn/start") {
		let { threadId } = params;
		let turnId = crypto.randomUUID();
		let text = params.input[0].text as string;
		send({ id, result: { turn: { id: turnId } } });
		let done = (text: string) => finish(threadId, turnId, text);
		if (params.outputSchema?.properties?.requestsInput) {
			setTimeout(() => done(JSON.stringify({ requestsInput: false })), 5);
			return;
		}
		let identity = `Conversation ${threadId}; model ${params.model ?? "codex-test"}.`;
		if (text.startsWith("Experiment:")) {
			writeFileSync(join(contexts.get(threadId).cwd, "source.txt"), "Selected prototype source.\n");
			setTimeout(() => done("Prototype implemented and tested."), 5);
			return;
		}
		if (text.includes("build and run")) {
			let context = contexts.get(threadId);
			let prompt = context.developerInstructions.replace(/\s+/g, " ");
			if (
				!prompt.includes("then call `prototype_local` in this turn")
				|| prompt.includes("`read_implementation_graph`")
				|| !context.dynamicTools.some((tool: { name: string }) => tool.name === "prototype_local")
			) {
				done("Local implementation instructions or tools are missing.");
				return;
			}
			call(threadId, turnId, "prototype_local", {
				name: "Alternative A",
				goal: "Test a source change",
			}, result => {
				if (result.success) {
					let data = JSON.parse(result.contentItems[0].text);
					checkpoints.set(threadId, data.id);
					done("Alternative A is ready in its copy.");
				} else done("Prototype failed: " + result.contentItems[0].text);
			});
			return;
		}
		if (text.includes("Apply alternative")) {
			call(
				threadId,
				turnId,
				"apply_local_checkpoint",
				{ id: checkpoints.get(threadId), commitMessage: "Implement selected checkpoint" },
				result =>
					done(
						result.success
							? "Selected changes applied. Commit manually: Implement selected checkpoint."
							: "Application failed: " + result.contentItems[0].text,
					),
			);
			return;
		}
		if (text.includes("Verify my commit")) {
			call(
				threadId,
				turnId,
				"verify_local_commit",
				{ id: checkpoints.get(threadId) },
				result =>
					done(
						result.success
							? "Manual commit verified. Ready for the next checkpoint."
							: "Commit is still required.",
					),
			);
			return;
		}
		if (text.includes("Wait for Stop")) return;
		if (text.includes("Ask for approval")) {
			let request = ++sequence;
			pending.set(
				request,
				result =>
					done(
						result.decision === "accept"
							? "Command approved in Chopin."
							: "Command declined in Chopin.",
					),
			);
			send({
				id: request,
				method: "item/commandExecution/requestApproval",
				params: { threadId, turnId, command: "Read source files", cwd: process.cwd() },
			});
		} else if (text.includes("Update the document")) {
			call(threadId, turnId, "read_plan", {}, read => {
				let revision = Number(/revision: (\d+)/.exec(read.contentItems[0].text)?.[1]);
				call(
					threadId,
					turnId,
					"edit_plan",
					{
						revision,
						operations: [{
							op: "replace",
							index: 1,
							source: "Updated through the dedicated Codex conversation.\n",
						}],
					},
					edited =>
						done(edited.success ? "Document updated through Chopin." : "Document update failed."),
				);
			});
		} else {
			call(
				threadId,
				turnId,
				"read_repository_file",
				{ path: "source.txt" },
				read => done(`${identity} Source: ${read.contentItems[0].text}`),
			);
		}
		return;
	}
	if (id !== undefined) send({ id, result });
});
