import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

import type {
	AiChoice,
	AiConnection,
	AiRole,
	LocalAiConfiguration,
} from "@chopin/protocol/local-ai";

const role = z.enum(["planner", "classifier", "prototyping"]);
const choice = z.object({
	connection: z.string(),
	model: z.string().min(1).max(300),
	thinkingLevel: z.string().min(1).max(100).optional(),
}).strict();
const schema = z.object({
	version: z.literal(1),
	revision: z.number().int().min(0),
	connections: z.array(
		z.object({
			id: z.string().regex(/^[a-z][a-z0-9-]{0,49}$/),
			name: z.string().min(1).max(100),
			transport: z.enum(["codex", "acp"]),
			command: z.array(z.string().min(1).max(2000)).min(1).max(30),
			mode: z.enum(["launch", "attach"]),
			modelHosts: z.array(z.string().regex(/^[a-z0-9.-]+(?::\d+)?$/i)).max(30),
			models: z.array(
				z.object({
					id: z.string().min(1).max(300),
					name: z.string().min(1).max(300),
					thinkingLevels: z.array(z.string().min(1).max(100)).optional(),
				}).strict(),
			).max(500),
			registeredAt: z.string().datetime().optional(),
			launchApproved: z.boolean(),
		}).strict(),
	).max(30),
	roles: z.partialRecord(role, choice),
}).strict();

export function localStateDirectory(): string {
	return process.env.CHOPIN_WORKSPACE_DIR
		|| join(
			process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
			"chopin",
			"workspace",
		);
}

export const EMPTY_AI: LocalAiConfiguration = {
	version: 1,
	revision: 0,
	connections: [],
	roles: {},
};

export function validateAiConfiguration(value: unknown): LocalAiConfiguration {
	let parsed = schema.parse(value);
	let ids = new Set<string>();
	for (let connection of parsed.connections) {
		if (ids.has(connection.id)) throw new Error("Connection IDs must be unique");
		ids.add(connection.id);
		if (!isAbsolute(connection.command[0]!)) {
			throw new Error("Agent commands must begin with an absolute executable path");
		}
		if (connection.launchApproved && !connection.registeredAt) {
			throw new Error("Connect this agent to Chopin through MCP before approving launch");
		}
	}
	for (let [name, selected] of Object.entries(parsed.roles)) {
		if (name === "prototyping" && /astra/i.test(selected.model)) {
			throw new Error(
				"Astra is not enabled for prototyping; select Sol or another configured worker model",
			);
		}
		let connection = parsed.connections.find(item => item.id === selected.connection);
		let model = connection?.models.find(item => item.id === selected.model);
		if (!model) throw new Error(`${name}: select a model reported by its connection`);
		if (selected.thinkingLevel && !model.thinkingLevels?.includes(selected.thinkingLevel)) {
			throw new Error(`${name}: this model does not offer that thinking level`);
		}
	}
	return parsed;
}

const queues = new Map<string, Promise<void>>();

export class AiSettings {
	readonly directory: string;
	constructor(directory = localStateDirectory()) {
		this.directory = directory;
	}
	async read(): Promise<LocalAiConfiguration> {
		try {
			return validateAiConfiguration(
				JSON.parse(await readFile(join(this.directory, "ai.json"), "utf8")),
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY_AI);
			throw error;
		}
	}
	async update(
		work: (current: LocalAiConfiguration) => LocalAiConfiguration,
	): Promise<LocalAiConfiguration> {
		let operation = (queues.get(this.directory) ?? Promise.resolve()).then(async () => {
			let current = await this.read();
			let next = validateAiConfiguration(work(structuredClone(current)));
			next.revision = current.revision + 1;
			await mkdir(this.directory, { recursive: true, mode: 0o700 });
			let temporary = join(this.directory, `ai.${crypto.randomUUID()}.json`);
			await writeFile(temporary, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
			await rename(temporary, join(this.directory, "ai.json"));
			return next;
		});
		queues.set(this.directory, operation.then(() => {}, () => {}));
		return operation;
	}
	async save(input: unknown): Promise<LocalAiConfiguration> {
		let requested = validateAiConfiguration(input);
		return this.update(current => {
			if (requested.revision !== current.revision) {
				throw new Error("AI settings changed. Reload before saving.");
			}
			for (let connection of requested.connections) {
				let prior = current.connections.find(item => item.id === connection.id);
				// Registration is an observed MCP handshake. A browser cannot mint it or transfer it
				// to a different command; changing a command requires the connection to register again.
				let same = prior && JSON.stringify(prior.command) === JSON.stringify(connection.command)
					&& prior.transport === connection.transport
					&& JSON.stringify(prior.modelHosts) === JSON.stringify(connection.modelHosts);
				connection.registeredAt = same ? prior?.registeredAt : undefined;
				connection.models = same ? prior!.models : [];
				if (connection.launchApproved && !connection.registeredAt) {
					throw new Error("Register this exact agent command through MCP first");
				}
			}
			return requested;
		});
	}
	async register(id: string): Promise<LocalAiConfiguration> {
		return this.update(current => {
			let connection = current.connections.find(item => item.id === id);
			if (!connection) throw new Error("Add this connection in AI settings first");
			connection.registeredAt = new Date().toISOString();
			return current;
		});
	}
}

/** Called once at startup. Saved edits take effect on the next launch. */
export function activeAiConfiguration(): LocalAiConfiguration {
	let raw = process.env.CHOPIN_LOCAL_AI;
	return raw ? validateAiConfiguration(JSON.parse(raw)) : structuredClone(EMPTY_AI);
}

export function roleConnection(
	config: LocalAiConfiguration,
	name: AiRole,
): { connection: AiConnection; choice: AiChoice } {
	let selected = config.roles[name];
	let connection = config.connections.find(item => item.id === selected?.connection);
	if (!selected || !connection) {
		throw new Error(`Configure the ${name} AI in AI settings and restart Chopin`);
	}
	if (!connection.registeredAt || connection.mode === "launch" && !connection.launchApproved) {
		throw new Error(`Finish the two-way setup for ${connection.name} before running it`);
	}
	return { connection, choice: selected };
}
