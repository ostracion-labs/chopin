import { activeAiConfiguration, AiSettings } from "./ai-config";
import { attachedRuntime } from "./attached-runtime";
import { probeLocalModels } from "./ai-runtime";
import { workspaceCheckpoints } from "./ai-tools";
import type { Router } from "../http/router";
import type { HostedAuth } from "../auth/routes";

/** Passive discovery only: installed programs are never started during a scan. */
export function discoverLocalAgents() {
	return [
		{
			id: "codex",
			name: "Codex",
			program: "codex",
			transport: "codex",
			args: [],
			hosts: ["chatgpt.com", "auth.openai.com", "api.openai.com"],
		},
		{
			id: "claude",
			name: "Claude Code (ACP adapter)",
			program: "claude-agent-acp",
			transport: "acp",
			args: [],
			hosts: ["api.anthropic.com", "platform.claude.com"],
		},
		{
			id: "opencode",
			name: "OpenCode (ACP)",
			program: "opencode",
			transport: "acp",
			args: ["acp"],
			hosts: [],
		},
		{
			id: "atomic",
			name: "Atomic (ACP)",
			program: "atomic-acp",
			transport: "acp",
			args: [],
			hosts: [],
		},
	].map(item => ({
		...item,
		path: Bun.which(item.program),
		installed: !!Bun.which(item.program),
		command: Bun.which(item.program) ? [Bun.which(item.program)!, ...item.args] : [],
		needsAdapter: item.id === "claude" && !!Bun.which("claude") && !Bun.which(item.program),
	}));
}

export function workspaceAiMcpTools() {
	let settings = new AiSettings();
	let outputSchema = { type: "object", additionalProperties: true };
	return [
		{
			name: "describe_workspace_ai",
			description:
				"Discover this local Chopin's Planner, Classifier and Prototyping AI roles, registered runtime connections, MCP two-way setup, attachment protocol, and human/manual-commit checkpoint workflow. Never launch or install an AI just by discovering it.",
			inputSchema: { type: "object", properties: {}, additionalProperties: false },
			outputSchema,
			execute: async () => ({
				configuration: await settings.read(),
				installed: discoverLocalAgents(),
				active: activeAiConfiguration(),
				setup:
					"Ask the human to add a connection in /settings/ai, add this /mcp endpoint to their chosen agent using the local workspace credential, then call confirm_workspace_ai_connection. The human approves automatic launch and chooses each role's model and thinking level in AI settings. Saved settings activate on the next Chopin launch. For manual attachment use scripts/workspace-agent.ts with the saved connection ID. No agent can approve its own launch or apply a prototype without the human's saved Decision.",
				checkpointFlow: [
					"prototype in independent copies",
					"human selects sub-final checkpoint",
					"apply sealed files after conflict checks",
					"human commits manually (AI may suggest message)",
					"verify the commit contains the checkpoint",
					"continue",
				],
			}),
		},
		{
			name: "confirm_workspace_ai_connection",
			description:
				"Confirm the human has added Chopin to this AI's MCP tools. This records a two-way handshake only; it does not approve launching the AI, change role defaults, grant source writes, commit or push. The human must finish setup in /settings/ai.",
			inputSchema: {
				type: "object",
				properties: { connection: { type: "string" } },
				required: ["connection"],
				additionalProperties: false,
			},
			outputSchema,
			execute: async (
				_caller: unknown,
				input: Record<string, unknown>,
				_client: unknown,
				registered: boolean,
			) => {
				if (
					!registered || typeof input.connection !== "string" || Object.keys(input).length !== 1
				) {
					throw new Error(
						"Initialize an authenticated MCP session and provide its saved connection ID",
					);
				}
				let next = await settings.register(input.connection);
				return {
					registered: input.connection,
					revision: next.revision,
					next:
						"The human can now probe models, approve launch, select role defaults and restart Chopin.",
				};
			},
		},
	];
}

export function registerWorkspaceAiRoutes(router: Router, auth: HostedAuth): void {
	if (!auth.config.workspace) return;
	let settings = new AiSettings();
	const response = (value: unknown, status = 200) =>
		Response.json(value, { status, headers: { "cache-control": "no-store" } });
	const protectedRoute = (
		handler: (request: Request, params: Readonly<Record<string, string>>) => Promise<Response>,
		bearer = false,
	) =>
	async (request: Request, _url: URL, params: Readonly<Record<string, string>>) => {
		try {
			let allowed = await auth.sessions.authenticate(request);
			if (!allowed && bearer) {
				let token = request.headers.get("authorization")?.replace(/^Bearer /i, "");
				if (token) await auth.github.user(token);
				else return response({ error: "Authentication required" }, 401);
			} else if (!allowed) return response({ error: "Authentication required" }, 401);
			if (
				request.method !== "GET" && !bearer
				&& request.headers.get("origin") !== auth.config.origin
			) return response({ error: "Origin required" }, 403);
			if (Number(request.headers.get("content-length") ?? 0) > 128 * 1024) {
				return response({ error: "Request too large" }, 413);
			}
			return await handler(request, params);
		} catch (error) {
			return response({
				error: error instanceof Error ? error.message : "Local AI request failed",
			}, 400);
		}
	};
	router.on(
		"GET",
		"/api/workspace/ai",
		protectedRoute(async () =>
			response({
				pending: await settings.read(),
				active: activeAiConfiguration(),
				discovered: discoverLocalAgents(),
			})
		),
	);
	router.on(
		"PUT",
		"/api/workspace/ai",
		protectedRoute(async request =>
			response({ pending: await settings.save(await request.json()), restartRequired: true })
		),
	);
	router.on(
		"POST",
		"/api/workspace/ai/:id/probe",
		protectedRoute(async (_request, params) => {
			let config = await settings.read();
			let connection = config.connections.find(item => item.id === params.id);
			if (!connection?.registeredAt) throw new Error("Complete MCP registration first");
			let catalog = await probeLocalModels(connection);
			await settings.update(next => {
				let selected = next.connections.find(item => item.id === connection.id)!;
				if (
					JSON.stringify(selected.command) !== JSON.stringify(connection.command)
				) throw new Error("The connection changed during discovery");
				selected.models = catalog.models.map(({ id, name, thinkingLevels }) => ({
					id,
					name,
					...(thinkingLevels?.length ? { thinkingLevels } : {}),
				}));
				return next;
			});
			return response({ catalog });
		}),
	);
	router.on(
		"GET",
		"/api/workspace/checkpoints/:document",
		protectedRoute(async (_request, params) =>
			response({
				checkpoints: (await workspaceCheckpoints().list(params.document)).map((
					{ baseline: _baseline, ...record },
				) => record),
			})
		),
	);
	router.on(
		"GET",
		"/api/workspace/agents/:id",
		protectedRoute(async (_request, params) => {
			let config = activeAiConfiguration();
			let connection = config.connections.find(item => item.id === params.id);
			if (!connection || connection.mode !== "attach" || !connection.registeredAt) {
				throw new Error("Configure and register a manual connection first");
			}
			return response({ connection });
		}, true),
	);
	router.on(
		"POST",
		"/api/workspace/agents/:id/poll",
		protectedRoute(async (request, params) => {
			let connection = activeAiConfiguration().connections.find(item => item.id === params.id);
			if (!connection?.registeredAt || connection.mode !== "attach") {
				throw new Error("The connection is not registered for attachment");
			}
			let body = await request.json();
			if (typeof body.lease !== "string" || body.lease.length > 100) {
				throw new Error("Bridge lease required");
			}
			return response({
				messages: await attachedRuntime(params.id!).poll(body.lease, request.signal),
			});
		}, true),
	);
	router.on(
		"POST",
		"/api/workspace/agents/:id/events",
		protectedRoute(async (request, params) => {
			let connection = activeAiConfiguration().connections.find(item => item.id === params.id);
			if (!connection?.registeredAt || connection.mode !== "attach") {
				throw new Error("The connection is not active for attachment");
			}
			let body = await request.json();
			if (
				typeof body.lease !== "string" || typeof body.message !== "object" || !body.message
			) throw new Error("Bridge lease and message required");
			attachedRuntime(params.id!).receive(body.lease, body.message);
			return response({ ok: true });
		}, true),
	);
}
