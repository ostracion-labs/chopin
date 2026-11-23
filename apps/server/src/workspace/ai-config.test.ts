import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiSettings, EMPTY_AI, roleConnection, validateAiConfiguration } from "./ai-config";
import type { AiConnection } from "@chopin/protocol/local-ai";
let directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
const connection = (): AiConnection => ({
	id: "codex",
	name: "Codex",
	command: ["/absolute/codex"],
	transport: "codex",
	mode: "launch",
	modelHosts: [],
	models: [],
	launchApproved: false,
});
test("two-way registration cannot be forged in browser settings; model catalog is server-owned", async () => {
	let directory = await mkdtemp(join(tmpdir(), "chopin-ai-settings-"));
	directories.push(directory);
	let settings = new AiSettings(directory);
	let config = await settings.save({
		...EMPTY_AI,
		connections: [{
			...connection(),
			registeredAt: new Date().toISOString(),
			models: [{ id: "invented", name: "Invented" }],
		}],
	});
	expect(config.connections[0]!.registeredAt).toBeUndefined();
	expect(config.connections[0]!.models).toEqual([]);
	config.connections[0]!.launchApproved = true;
	await expect(settings.save(config)).rejects.toThrow("MCP");
	config = await settings.register("codex");
	config = await settings.update(current => {
		current.connections[0]!.models = [{ id: "sol", name: "Sol", thinkingLevels: ["high"] }, {
			id: "luna",
			name: "Luna",
		}];
		return current;
	});
	config.connections[0]!.launchApproved = true;
	config.roles = {
		planner: { connection: "codex", model: "sol", thinkingLevel: "high" },
		classifier: { connection: "codex", model: "luna" },
	};
	config = await settings.save(config);
	expect(roleConnection(config, "classifier").choice.model).toBe("luna");
	await expect(settings.save({ ...config, revision: config.revision - 1 })).rejects.toThrow(
		"Reload",
	);
	config.connections[0]!.command = ["/another/agent"];
	config.connections[0]!.launchApproved = false;
	config.roles = {};
	config = await settings.save(config);
	expect(config.connections[0]!.registeredAt).toBeUndefined();
	expect(config.connections[0]!.models).toEqual([]);
});
test("separate settings readers serialize updates and reject unsupported role settings", async () => {
	let directory = await mkdtemp(join(tmpdir(), "chopin-ai-settings-"));
	directories.push(directory);
	let a = new AiSettings(directory);
	let b = new AiSettings(directory);
	await a.save({ ...EMPTY_AI, connections: [connection()] });
	await Promise.all([
		a.update(current => {
			current.connections[0]!.name += " A";
			return current;
		}),
		b.update(current => {
			current.connections[0]!.name += " B";
			return current;
		}),
	]);
	expect((await a.read()).connections[0]!.name).toBe("Codex A B");
	let config = {
		...EMPTY_AI,
		connections: [{
			...connection(),
			models: [{ id: "sol", name: "Sol", thinkingLevels: ["high"] }],
		}],
		roles: { planner: { connection: "codex", model: "sol", thinkingLevel: "ultra" } },
	};
	expect(() => validateAiConfiguration(config)).toThrow("thinking level");
	expect(() => roleConnection(EMPTY_AI, "prototyping")).toThrow("Configure");
});
