import { afterEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	readSettings,
	workspaceEnvironment,
	workspaceStartupEnvironment,
	workspaceUnit,
} from "./workspace";
import type { LocalAiConfiguration } from "../packages/protocol/local-ai";

let directories: string[] = [];
afterEach(() => {
	for (let directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it("loads a private local checkout and produces a model-free, loopback runtime", () => {
	let root = mkdtempSync(join(tmpdir(), "chopin-launcher-"));
	directories.push(root);
	mkdirSync(join(root, ".git"));
	writeFileSync(
		join(root, "settings.json"),
		JSON.stringify({
			version: 1,
			token: "a".repeat(43),
			port: 8793,
			databaseUrl: "postgresql://localhost/chopin",
			repositories: [{ name: "local/project", path: root }],
		}),
	);
	let settings = readSettings(root);
	expect(workspaceEnvironment(settings)).toMatchObject({
		CHOPIN_MODE: "workspace",
		APP_ORIGIN: "http://127.0.0.1:8793",
		SERVER_HOST: "127.0.0.1",
		AGENT: "off",
		BACKGROUND_JOBS: "off",
		WEB_RESEARCH: "off",
		LIVE_BUILD: "off",
		LIVE_SPIKES: "off",
	});
	let link = join(root, "redirected");
	mkdirSync(link);
	symlinkSync(join(root, "settings.json"), join(link, "settings.json"));
	expect(() => readSettings(link)).toThrow("regular file");
});

it("quotes service paths and stores no workspace token or database credential in the unit", () => {
	let unit = workspaceUnit(
		'/tmp/state "quoted" %name',
		"/tmp/source with spaces",
		"/tmp/tools/bun",
	);
	expect(unit).toContain("WorkingDirectory=/tmp/source with spaces");
	expect(unit).toContain(
		'ExecStart="/tmp/tools/bun" "/tmp/source with spaces/scripts/workspace.ts" start',
	);
	expect(unit).toContain("%%name");
	expect(unit).toContain("Restart=on-failure");
	expect(unit).not.toContain("CHOPIN_WORKSPACE_TOKEN");
	expect(unit).not.toContain("DATABASE_URL");
});

it("enables only the selected Codex and keeps its executable stable for a background service", () => {
	let env = workspaceEnvironment({
		version: 1,
		token: "a".repeat(43),
		port: 8787,
		databaseUrl: "postgresql://localhost/test",
		repositories: [],
		agent: "codex",
		codexCommand: "/tmp/bin/codex",
	});
	expect(env).toMatchObject({
		CHOPIN_WORKSPACE_AGENT: "codex",
		CHOPIN_CODEX_COMMAND: "/tmp/bin/codex",
		AGENT: "on",
		BACKGROUND_JOBS: "off",
		WEB_RESEARCH: "off",
		CONVERSATION_PLAN: "off",
		LIVE_BUILD: "off",
	});
});

it("keeps the server available with AI off until all roles and launch approvals are ready", () => {
	let settings = {
		version: 1 as const,
		token: "a".repeat(43),
		port: 8787,
		databaseUrl: "postgresql://localhost/test",
		repositories: [],
		agent: "codex" as const,
	};
	let ai: LocalAiConfiguration = {
		version: 1,
		revision: 1,
		connections: [{
			id: "codex",
			name: "Codex",
			transport: "codex",
			command: ["/test/codex"],
			mode: "launch",
			modelHosts: [],
			models: [{ id: "sol", name: "Sol" }],
			registeredAt: new Date().toISOString(),
			launchApproved: false,
		}],
		roles: Object.fromEntries(
			["planner", "classifier", "prototyping"].map(
				role => [role, { connection: "codex", model: "sol" }],
			),
		),
	};
	let blocked = workspaceStartupEnvironment(settings, ai);
	expect(blocked.env).toMatchObject({
		AGENT: "off",
		CHOPIN_WORKSPACE_AGENT: "off",
		CHOPIN_LOCAL_AI: "",
	});
	expect(blocked.notice).toContain("Open /settings/ai");
	expect(ai.connections[0]!.launchApproved).toBe(false);
	ai.connections[0]!.launchApproved = true;
	expect(workspaceStartupEnvironment(settings, ai).env).toMatchObject({
		AGENT: "on",
		CHOPIN_WORKSPACE_AGENT: "codex",
		CHOPIN_LOCAL_AI: JSON.stringify(ai),
	});
	delete ai.roles.classifier;
	expect(workspaceStartupEnvironment(settings, ai).env.AGENT).toBe("off");
	ai.roles.classifier = { connection: "codex", model: "sol" };
	expect(workspaceStartupEnvironment({ ...settings, agent: "off" }, ai).env.AGENT).toBe("off");
	ai.connections[0]!.registeredAt = undefined;
	expect(workspaceStartupEnvironment(settings, ai).env.AGENT).toBe("off");
});
