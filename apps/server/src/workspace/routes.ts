import { Admission } from "../auth/admission";
import { ownOrigin } from "../auth/config";
import { Machines } from "../auth/machines";
import { Sessions } from "../auth/session";
import { WorkspaceAuthority } from "./authority";
import { GitHubError } from "../github/client";

import type { HostedAuth } from "../auth/routes";
import type { AuthConfig } from "../auth/config";
import type { Router } from "../http/router";
import type { StorageAdapter } from "../storage/port";

function json(value: unknown, status = 200): Response {
	return Response.json(value, {
		status,
		headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
	});
}

async function loginToken(request: Request): Promise<string | undefined> {
	if (!request.body) return;
	let reader = request.body.getReader();
	let chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			let next = await reader.read();
			if (next.done) break;
			length += next.value.length;
			if (length > 1024) {
				await reader.cancel();
				return;
			}
			chunks.push(next.value);
		}
		let body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (!body || typeof body !== "object") return;
		let token = (body as { token?: unknown }).token;
		return typeof token === "string" ? token : undefined;
	} catch {
		return;
	} finally {
		reader.releaseLock();
	}
}

const DOCUMENT_FRAMES = new Set([
	"session:ping",
	"plan:open",
	"plan:update",
	"plan:awareness",
	"plan:titling",
	"plan:close",
	"chat:typing",
	"chat:send",
	"chat:delete",
	"question:create",
	"question:open",
	"question:edit",
	"question:discard",
	"question:reopen",
	"question:presence",
	"question:submit",
	"question:cancel",
	"question:why",
	"question:option",
	"question:criterion",
	"question:take",
	"question:page",
	"comment:start",
	"comment:reply",
	"comment:typing",
	"comment:resolve",
	"comment:reopen",
]);

/** Local browser actions may change documents, but never schedule model or execution work. */
export function workspaceFrameAllowed(
	frame: { kind: string; to?: unknown },
	agent = false,
): boolean {
	return (DOCUMENT_FRAMES.has(frame.kind)
		|| agent && ["chat:model", "chat:abort", "chat:unqueue", "chat:retry"].includes(frame.kind))
		&& (agent || frame.to !== "planner");
}

/** All request paths are checked before router dispatch, including WebSocket upgrades. */
export function workspaceRequest(
	request: Request,
	origin: string,
	agent = false,
): Response | undefined {
	let url = new URL(request.url);
	if ((request.headers.get("host") ?? url.host) !== new URL(origin).host) {
		return json({ error: "Workspace host is not allowed" }, 403);
	}
	let suppliedOrigin = request.headers.get("origin");
	if (suppliedOrigin && suppliedOrigin !== origin) {
		return json({ error: "Workspace origin is not allowed" }, 403);
	}
	let path = url.pathname;
	let api = path === "/api/session"
		|| path.startsWith("/api/workspace/")
		|| agent && /^\/api\/channels\/[^/]+\/agent\/reset$/.test(path)
		|| /^\/api\/github\/installations(?:\/1\/repositories)?$/.test(path)
		|| /^\/api\/navigation(?:\/projects(?:\/[^/]+)?)?$/.test(path)
		|| /^\/api\/repositories\/[^/]+\/[^/]+\/(?:channels|documents\/[^/]+)$/.test(path)
		|| /^\/api\/channels\/[^/]+(?:\/(?:archive|restore|version-summaries|versions(?:\/[^/]+(?:\/restore)?)?))?$/
			.test(path);
	let auth = path === "/auth/workspace" || path === "/auth/logout";
	if (
		(path.startsWith("/api/") && !api) || (path.startsWith("/auth/") && !auth)
		|| path === "/machines" || path === "/connect"
		|| path.startsWith("/connector")
	) return json({ error: "This feature is unavailable in local workspace mode" }, 403);
	return undefined;
}

export function registerWorkspaceAuth(
	router: Router,
	dependencies: {
		config: AuthConfig;
		storage: StorageAdapter;
		clock?: () => Date;
		onSessionRevoked?: (id: string) => Promise<void>;
		agent?: boolean;
	},
): HostedAuth {
	let { config, storage } = dependencies;
	if (!config.workspace) throw new Error("Workspace configuration is missing");
	let clock = dependencies.clock ?? (() => new Date());
	let authority = new WorkspaceAuthority(config.workspace, config.origin);
	let admission = new Admission(config, authority, () => clock().getTime());
	let sessions = new Sessions(storage, new URL(config.origin).protocol === "https:", clock, {
		persistence: { key: config.encryptionKey, origin: config.origin, clientId: config.clientId },
		refresh: token => authority.refresh({ refreshToken: token }),
		authorize: async (user, token) => (await authority.user(token)).id === user.id,
		onRevoked: dependencies.onSessionRevoked,
		cookieSuffix: `_workspace_${new URL(config.origin).port}`,
	});
	let context: HostedAuth = {
		config,
		storage,
		github: authority,
		admission,
		sessions,
		// Satisfies the current auth container only; no machine route accepts a workspace request.
		machines: new Machines(storage, clock, { origin: config.origin, clientId: config.clientId }),
		pairings: {},
		clock,
	};
	router.on("GET", "/api/session", async request => {
		let current = await sessions.authenticate(request);
		return json({
			auth: "workspace",
			agent: dependencies.agent ?? false,
			user: current ? authority.userProfile : null,
			...(current ? { expiresAt: current.session.expiresAt.toISOString() } : {}),
		});
	});
	router.on("GET", "/workspace-avatar.svg", () =>
		new Response(
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="currentColor" d="M16 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM3 30a13 13 0 0 1 26 0Z"/></svg>',
			{ headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } },
		));
	router.on("POST", "/auth/workspace", async request => {
		if (!ownOrigin(config, request.headers.get("origin"))) {
			return json({ error: "Origin is not allowed" }, 403);
		}
		if (Number(request.headers.get("content-length") ?? 0) > 1024) {
			return json({ error: "Invalid workspace credential" }, 400);
		}
		let token = await loginToken(request);
		if (!token) return json({ error: "Invalid workspace credential" }, 400);
		try {
			let grant = authority.grant(token);
			await storage.users.put({ ...authority.userProfile, now: clock() });
			let issued = await sessions.issue(authority.userProfile.id, grant);
			let response = json({ ok: true });
			response.headers.set("set-cookie", issued.cookie);
			return response;
		} catch (error) {
			return error instanceof GitHubError && error.status === 401
				? json({ error: "Invalid workspace credential" }, 401)
				: json({ error: "Workspace session storage is unavailable" }, 503);
		}
	});
	router.on("POST", "/auth/logout", async request => {
		if (!ownOrigin(config, request.headers.get("origin"))) {
			return json({ error: "Origin is not allowed" }, 403);
		}
		await sessions.revoke(request);
		return new Response(null, {
			status: 204,
			headers: { "set-cookie": sessions.clearCookie(), "cache-control": "no-store" },
		});
	});
	// Compatibility listing routes feed the existing picker; they never contact GitHub.
	router.on("GET", "/api/github/installations", async request => {
		let current = await sessions.authenticate(request);
		if (!current) return json({ error: "Authentication required" }, 401);
		return json(await authority.installations(current.access.token, 1));
	});
	router.on(
		"GET",
		"/api/github/installations/:installationId/repositories",
		async (request, _url, params) => {
			let current = await sessions.authenticate(request);
			if (!current) return json({ error: "Authentication required" }, 401);
			if (params.installationId !== "1") return json({ error: "Workspace not found" }, 404);
			return json(await authority.installationRepositories(current.access.token, "1", 1));
		},
	);
	return context;
}
