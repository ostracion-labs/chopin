import { expect, test } from "bun:test";
import { mcpInput } from "./mcp-input";
import type { HumanInput } from "../atomic/human-input";

let signal = new AbortController().signal;
const human = (values: string[], cancelled = false) =>
	({
		questionnaire: async () => ({
			cancelled,
			answers: values.map((answer, questionIndex) => ({ questionIndex, kind: "option", answer })),
		}),
		confirm: async () => true,
	}) as unknown as HumanInput;
const form = {
	mode: "form",
	message: "Choose execution parameters",
	requestedSchema: {
		type: "object",
		required: ["enabled", "count", "name"],
		properties: {
			enabled: { type: "boolean" },
			count: { type: "integer", minimum: 1, maximum: 5 },
			name: { type: "string", enum: ["Alpha", "Beta"] },
		},
	},
};

test("MCP forms preserve named, typed answers from human Decisions", async () => {
	expect(await mcpInput(form, human(["Yes", "3", "Beta"]), signal, "session", "request")).toEqual({
		action: "accept",
		content: { enabled: true, count: 3, name: "Beta" },
	});
});
test("MCP forms refuse invalid answers, unsupported schemas and host URL authentication", async () => {
	for (
		let values of [["Yes", "6", "Beta"], ["Yes", "1.5", "Beta"], ["Yes", "", "Beta"], [
			"Yes",
			"2",
			"Other",
		], ["Yes"]]
	) {
		expect((await mcpInput(form, human(values), signal, "session", "request")).action).toBe(
			"decline",
		);
	}
	expect((await mcpInput({ ...form, mode: "url" }, human([]), signal, "session", "request")).action)
		.toBe("decline");
	expect(
		(await mcpInput(
			{ ...form, requestedSchema: { type: "object", properties: { list: { type: "array" } } } },
			human([]),
			signal,
			"session",
			"request",
		)).action,
	).toBe("decline");
});
test("MCP forms cancel on Stop or a cancelled Decision", async () => {
	expect((await mcpInput(form, human([], true), signal, "session", "request")).action).toBe(
		"cancel",
	);
	expect(
		(await mcpInput(form, human(["Yes", "3", "Beta"]), AbortSignal.abort(), "session", "request"))
			.action,
	).toBe("cancel");
});

test("native MCP tool confirmations show the entire proposed call and decline oversized hidden input", async () => {
	let confirmations: string[] = [];
	let input = {
		...human([]),
		confirm: async (_title: string, message: string) => {
			confirmations.push(message);
			return true;
		},
	} as HumanInput;
	let request = {
		mode: "form",
		message: "Run execute?",
		serverName: "configured",
		requestedSchema: { type: "object", properties: {} },
		_meta: {
			codex_approval_kind: "mcp_tool_call",
			tool_name: "execute",
			tool_params: { code: "write the prototype" },
		},
	};
	expect(await mcpInput(request, input, signal, "session", "request")).toEqual({
		action: "accept",
		content: {},
	});
	expect(confirmations[0]).toContain("write the prototype");
	expect(confirmations[0]).toContain("configured");
	expect(
		(await mcpInput(
			{ ...request, _meta: { ...request._meta, tool_params: { code: "x".repeat(12_000) } } },
			input,
			signal,
			"session",
			"request",
		)).action,
	).toBe("decline");
	expect(confirmations).toHaveLength(1);
});
