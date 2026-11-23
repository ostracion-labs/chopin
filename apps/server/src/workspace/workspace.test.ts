import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerAuthRoutes } from "../auth/routes";
import { describe as describeConfig } from "../config";
import { Router } from "../http/router";
import { registerMcpRoutes } from "../mcp/routes";
import { admit } from "../socket/admission";
import { MemoryStorage } from "../storage/memory/adapter";
import { configured } from "../testing/config";
import { workspaceRepositories } from "./config";
import { workspaceFrameAllowed, workspaceRequest } from "./routes";

const TOKEN = "workspace-test-" + "a".repeat(43);
const ORIGIN = "http://127.0.0.1:8787";
let directories: string[] = [];

function checkout() {
	let root = mkdtempSync(join(tmpdir(), "chopin-workspace-"));
	directories.push(root);
	mkdirSync(join(root, ".git"));
	writeFileSync(
		join(root, ".git/config"),
		'[remote "origin"]\nurl = git@gitlab.company.test:team/subgroup/project.git\n',
	);
	return root;
}

afterEach(() => {
	for (let directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function environment(path: string) {
	return {
		CHOPIN_MODE: "workspace",
		CHOPIN_WORKSPACE_TOKEN: TOKEN,
		CHOPIN_WORKSPACES: JSON.stringify([{ name: "local/project", path }]),
		APP_ORIGIN: ORIGIN,
		SERVER_HOST: "127.0.0.1",
		GITHUB_APP_CLIENT_ID: undefined,
		GITHUB_APP_CLIENT_SECRET: undefined,
		GITHUB_APP_SLUG: undefined,
		SESSION_ENCRYPTION_KEY: undefined,
	};
}

async function setup() {
	let path = checkout();
	let config = configured(environment(path)).auth;
	let storage = new MemoryStorage();
	let router = new Router();
	let auth = registerAuthRoutes(router, { config, storage });
	let lease = (await storage.leases.acquire("writer", "workspace-test", 60_000))!;
	registerMcpRoutes(router, auth, { lease: () => lease }, {
		visualAdmission: async () => {
			throw new Error("An unselected classifier ran");
		},
		invokePlanner: async () => {
			throw new Error("An unselected agent ran");
		},
	});
	let handle = async (path: string, init?: RequestInit) => {
		let request = new Request(ORIGIN + path, init);
		return workspaceRequest(request, ORIGIN) ?? (await router.handle(request))!;
	};
	let call = async (name: string, args: unknown, token = TOKEN) => {
		let response = await handle("/mcp", {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name, arguments: args },
			}),
		});
		return response;
	};
	let login = () =>
		handle("/auth/workspace", {
			method: "POST",
			headers: { origin: ORIGIN },
			body: JSON.stringify({ token: TOKEN }),
		});
	return { auth, storage, config, handle, call, login, path };
}

describe("local workspace mode", () => {
	it("allows document and human conversation frames, refusing model and build work on custom sockets", () => {
		for (
			let kind of ["plan:open", "plan:update", "question:submit", "comment:reply", "chat:send"]
		) {
			expect(workspaceFrameAllowed({ kind, to: "room" })).toBe(true);
		}
		for (
			let kind of [
				"implementation:draft",
				"chat:model",
				"chat:wake",
				"chat:retry",
				"job:list",
				"conversation-plan:research",
				"question:explore",
				"future:executor",
			]
		) {
			expect(workspaceFrameAllowed({ kind })).toBe(false);
		}
		for (let kind of ["chat:send", "comment:start", "comment:reply"]) {
			expect(workspaceFrameAllowed({ kind, to: "planner" })).toBe(false);
		}
	});
	it("starts without GitHub credentials and ignores all automatic AI and build selections", () => {
		let config = configured({
			...environment(checkout()),
			AGENT: "on",
			BACKGROUND_JOBS: "on",
			CONVERSATION_PLAN: "on",
			LIVE_BUILD: "on",
			LIVE_SPIKES: "on",
			HARNESS: "atomic",
			HARNESS_AUTH: "auto",
			MODEL: "unselected-model",
			DECISIONS_MODEL: "unselected/classifier",
			CONVERSATION_INITIATIVE_MODEL: "unselected/classifier",
			OPENAI_API_KEY: "must-not-be-used",
			JEV_API_KEY: "must-not-be-used",
		});
		expect(config).toMatchObject({
			agent: false,
			backgroundJobs: false,
			conversationPlan: false,
			webResearch: false,
			liveBuild: false,
			liveSpikes: false,
			decisionsModel: undefined,
			conversationInitiativeModel: undefined,
			model: "",
			historyModel: "",
			harness: "remote",
		});
		expect(describeConfig(config)).toContain("auth: local workspace (single owner)");
		expect(describeConfig(config)).not.toContain(TOKEN);
	});
	it("opts into only local Codex Chat, model selection, approvals and Stop without enabling Git or classifiers", () => {
		let config = configured({ ...environment(checkout()), CHOPIN_WORKSPACE_AGENT: "codex" });
		expect(config).toMatchObject({
			agent: true,
			harness: "codex",
			backgroundJobs: false,
			webResearch: false,
			decisionsModel: undefined,
			conversationPlan: false,
			liveBuild: false,
		});
		for (let kind of ["chat:send", "chat:model", "chat:abort", "chat:retry", "chat:unqueue"]) {
			expect(workspaceFrameAllowed({ kind, to: "planner" }, true)).toBe(true);
		}
		for (
			let kind of [
				"implementation:draft",
				"question:explore",
				"conversation-plan:research",
				"chat:resume-run",
			]
		) expect(workspaceFrameAllowed({ kind }, true)).toBe(false);
		for (
			let path of ["/api/v1/agent", "/api/connector/connections", "/api/channels/id/implementation"]
		) expect(workspaceRequest(new Request(ORIGIN + path), ORIGIN, true)?.status).toBe(403);
	});

	it("rejects a non-loopback bind, foreign origin, weak key, and an unknown mode", () => {
		let base = environment(checkout());
		expect(() => configured({ ...base, SERVER_HOST: "0.0.0.0" })).toThrow("loopback");
		expect(() => configured({ ...base, APP_ORIGIN: "https://company.test" })).toThrow("loopback");
		expect(() => configured({ ...base, CHOPIN_WORKSPACE_TOKEN: "short" })).toThrow("random token");
		expect(() => configured({ ...base, CHOPIN_MODE: "workspce" })).toThrow("CHOPIN_MODE");
	});

	it("registers GitLab and remote-less checkouts without modifying or executing Git configuration", () => {
		let path = checkout();
		let before = readFileSync(join(path, ".git/config"), "utf8");
		let first = workspaceRepositories(JSON.stringify([{ name: "Local/Project", path }]))[0]!;
		let link = path + "-link";
		symlinkSync(path, link);
		directories.push(link);
		let renamed = workspaceRepositories(
			JSON.stringify([{ name: "local/renamed", path: link }]),
		)[0]!;
		expect(first.id).toBe(renamed.id);
		expect(first.id).toStartWith("workspace:");
		expect(first.path).toBe(path);
		expect(readFileSync(join(path, ".git/config"), "utf8")).toBe(before);
		writeFileSync(join(path, ".git/config"), "");
		expect(workspaceRepositories(JSON.stringify([{ name: "local/project", path }]))).toHaveLength(
			1,
		);
		expect(() =>
			workspaceRepositories(
				JSON.stringify([{ name: "local/one", path }, { name: "local/two", path: link }]),
			)
		).toThrow("unique");
		expect(() => workspaceRepositories(JSON.stringify([{ name: "local/../escape", path }])))
			.toThrow("name");
	});

	it("requires the local key and same-origin login, persists the browser session, and signs out", async () => {
		let { handle, login, storage, config } = await setup();
		expect(await (await handle("/api/session")).json()).toMatchObject({
			auth: "workspace",
			user: null,
			agent: false,
		});
		expect(
			(await handle("/auth/workspace", { method: "POST", body: JSON.stringify({ token: TOKEN }) }))
				.status,
		).toBe(403);
		expect(
			(await handle("/auth/workspace", {
				method: "POST",
				headers: { origin: ORIGIN },
				body: JSON.stringify({ token: "wrong" }),
			})).status,
		).toBe(401);
		let response = await login();
		expect(response.status).toBe(200);
		let cookie = response.headers.get("set-cookie")!.split(";", 1)[0]!;
		expect(await (await handle("/api/session", { headers: { cookie } })).json()).toMatchObject({
			user: { id: "workspace:owner" },
		});
		let restarted = new Router();
		registerAuthRoutes(restarted, { config, storage });
		expect(
			await (await restarted.handle(new Request(ORIGIN + "/api/session", { headers: { cookie } })))!
				.json(),
		).toMatchObject({ user: { id: "workspace:owner" } });
		expect(
			(await handle("/auth/logout", { method: "POST", headers: { cookie, origin: ORIGIN } }))
				.status,
		).toBe(204);
		expect(await (await handle("/api/session", { headers: { cookie } })).json()).toMatchObject({
			user: null,
		});
	});

	it("creates and rewrites prose through MCP with no classifier, enforcing revisions and local scope", async () => {
		let { call, path, login, auth } = await setup();
		expect((await call("list_documents", { repository: "local/project" }, "wrong")).status).toBe(
			401,
		);
		let source = {
			repository: "local/project",
			baseBranch: "main",
			baseCommit: "a".repeat(40),
			title: "Local design",
			idempotencyKey: "local-first",
			plan: "# Local design\n\nA substantial paragraph saved without an extra model.\n",
			brief: {
				goal: "Design a local application",
				constraints: [],
				settledDecisions: [],
				openQuestions: [],
				repositoryFindings: [],
			},
		};
		let created = (await (await call("create_document", source)).json()).result.structuredContent;
		expect(created.id).toBeString();
		expect(created.url).toContain("/documents/local/project/");
		let cookie = (await login()).headers.get("set-cookie")!.split(";", 1)[0]!;
		let socketUrl = new URL(`${ORIGIN}/ws?channel=${created.id}`);
		let admission = await admit(
			new Request(socketUrl, { headers: { cookie, origin: ORIGIN } }),
			socketUrl,
			auth,
		);
		expect(admission).toMatchObject({
			data: { room: created.id, canEdit: true, repositoryOwner: "local" },
		});
		let listed =
			(await (await call("list_documents", { repository: "local/project" })).json()).result
				.structuredContent;
		expect(listed.documents).toHaveLength(1);
		let rewritten = (await (await call("update_document", {
			id: created.id,
			revision: 0,
			plan: "# Local design\n\nThe selected agent revised this document.\n",
			idempotencyKey: "local-edit",
		})).json()).result.structuredContent;
		expect(rewritten.revision).toBe(1);
		let conflict = (await (await call("update_document", {
			id: created.id,
			revision: 0,
			plan: "# Stale\n",
			idempotencyKey: "stale",
		})).json()).result.structuredContent;
		expect(conflict.code).toBe("revision-conflict");
		let foreign =
			(await (await call("list_documents", { repository: "company/unregistered" })).json()).result;
		expect(foreign.isError).toBe(true);
		expect(readFileSync(join(path, ".git/config"), "utf8")).toContain("gitlab.company.test");
	});

	it("advertises no execution tools and rejects direct calls and machine/build routes", async () => {
		let { handle, call } = await setup();
		let response = await handle("/mcp", {
			method: "POST",
			headers: { authorization: `Bearer ${TOKEN}` },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		let tools = (await response.json()).result.tools.map((tool: { name: string }) => tool.name);
		expect(tools).toContain("update_document");
		for (
			let name of ["invoke_planner", "start_implementation", "read_implementation", "report_task"]
		) {
			expect(tools).not.toContain(name);
			let refused = await (await call(name, { id: crypto.randomUUID() })).json();
			expect(!!refused.error || refused.result?.isError === true).toBe(true);
		}
		for (
			let path of [
				"/api/connector/connections",
				"/connector/mcp",
				"/api/v1/agent",
				"/api/documents/id/experiments",
				"/api/documents/id/machine",
				"/api/channels/id/implementation",
				"/api/channels/id/research-workspaces",
				"/auth/github",
				"/machines",
				"/api/future-executor",
			]
		) {
			expect((await handle(path)).status).toBe(403);
		}
		expect((await handle("/api/session", { headers: { host: "attacker.test" } })).status).toBe(403);
		expect((await handle("/mcp", { headers: { origin: "https://attacker.test" } })).status).toBe(
			403,
		);
	});
});
