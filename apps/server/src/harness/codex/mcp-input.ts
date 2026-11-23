import type { HumanInput } from "../atomic/human-input";

/** Preserve MCP's field names/types while presenting the request through authoritative Decisions. */
export async function mcpInput(
	params: Record<string, any>,
	human: HumanInput,
	signal: AbortSignal,
	sessionId: string,
	requestId: string,
) {
	const refused = { action: "decline", content: null };
	if (signal.aborted) return { action: "cancel", content: null };
	if (!["form", "openai/form", "openaiForm"].includes(params.mode)) return refused;
	let schema = params.requestedSchema;
	if (
		!schema || schema.type !== "object" || typeof schema.properties !== "object"
		|| !schema.properties
	) return refused;
	let fields = Object.entries(schema.properties) as [string, Record<string, any>][];
	if (fields.length > 10) return refused;
	if (!fields.length) {
		let meta = params._meta;
		let command = meta?.codex_approval_kind === "mcp_tool_call"
			? JSON.stringify(
				{ server: params.serverName, tool: meta.tool_name, arguments: meta.tool_params },
				null,
				2,
			)
			: "";
		// A confirmation must show the entire proposed call, rather than hide executable input.
		if (command.length > 10_000) return refused;
		let yes = await human.confirm(
			"MCP confirmation",
			[String(params.message).slice(0, 2000), command].filter(Boolean).join("\n\n"),
			{
				signal,
				sessionId,
				requestId,
			},
		);
		return yes && !signal.aborted ? { action: "accept", content: {} } : refused;
	}
	let choices = fields.map(([_name, field]) =>
		field.type === "boolean"
			? ["Yes", "No"]
			: field.type === "string" && Array.isArray(field.enum)
					&& field.enum.every((value: unknown) => typeof value === "string")
			? field.enum as string[]
			: []
	);
	if (
		fields.some(([_name, field]) =>
			!["boolean", "number", "integer", "string"].includes(field.type)
		)
	) return refused;
	let result = await human.questionnaire({
		questions: fields.map(([name, field], i) => ({
			header: String(field.title ?? name).slice(0, 80),
			question: `${String(params.message).slice(0, 4_000)}\n\n${name}: ${
				String(field.description ?? field.title ?? name).slice(0, 2_000)
			}`,
			options: choices[i]!.map(label => ({ label, description: "" })),
		})),
	}, { signal, sessionId, requestId });
	if (result.cancelled || signal.aborted) return { action: "cancel", content: null };
	let content: Record<string, string | number | boolean> = {};
	for (let [i, [name, field]] of fields.entries()) {
		let value = result.answers.find(answer => answer.questionIndex === i)?.answer;
		if (value == null) {
			if (schema.required?.includes(name)) return refused;
			continue;
		}
		if (field.type === "boolean") {
			if (!["Yes", "No"].includes(value)) return refused;
			content[name] = value === "Yes";
		} else if (field.type === "number" || field.type === "integer") {
			let parsed = Number(value);
			if (
				!value.trim() || !Number.isFinite(parsed)
				|| field.type === "integer" && !Number.isInteger(parsed)
				|| field.minimum != null && parsed < field.minimum
				|| field.maximum != null && parsed > field.maximum
			) return refused;
			content[name] = parsed;
		} else {
			if (choices[i]!.length && !choices[i]!.includes(value)) return refused;
			content[name] = value;
		}
	}
	return { action: "accept", content };
}
