import { opendir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { tool } from "ai";
import { z } from "zod";

import type { WorkspaceRepository } from "./config";

const SKIP = new Set([".git", "node_modules", ".env", ".aws", ".ssh", ".codex"]);
const MAX_BYTES = 256 * 1024;

/** Reads working files directly. No Git command, repository hook, filter or remote is executed. */
export function localRepositoryTools(repositories: WorkspaceRepository[]) {
	const contextSchema = z.object({ repository: z.object({ id: z.string() }) });
	const root = (id: string, name?: string) => {
		let repository = repositories.find(item => name ? item.name === name : item.id === id);
		if (!repository) throw new Error("Register this local checkout before reading it.");
		return repository.path;
	};
	const location = async (directory: string, path: string) => {
		if (
			isAbsolute(path)
			|| path.split(/[\\/]/).some(part => SKIP.has(part) || part.startsWith(".env"))
		) {
			throw new Error("Use a relative source path; private configuration is not readable.");
		}
		let target = await realpath(resolve(directory, path));
		let rel = relative(directory, target);
		if (
			rel === ".." || rel.startsWith("../") || isAbsolute(rel)
			|| rel.split(/[\\/]/).some(part => SKIP.has(part) || part.startsWith(".env"))
		) {
			throw new Error("The path leaves the registered checkout or enters private configuration.");
		}
		return target;
	};
	async function* files(directory: string, prefix = ""): AsyncGenerator<string> {
		let count = 0;
		let pending = [prefix];
		while (pending.length && count < 5000) {
			let base = pending.pop()!;
			let folder = await location(directory, base || ".");
			for await (let entry of await opendir(folder)) {
				if (++count > 5000) return;
				if (SKIP.has(entry.name) || entry.name.startsWith(".env") || entry.isSymbolicLink()) {
					continue;
				}
				let path = base ? `${base}/${entry.name}` : entry.name;
				if (entry.isDirectory()) pending.push(path);
				else if (entry.isFile()) yield path;
			}
		}
	}
	const repository = z.string().optional().describe(
		"Optional registered local repository alias, e.g. local/frontend.",
	);
	return {
		read_repository_file: tool({
			contextSchema,
			description:
				"Read a UTF-8 source file from a registered LOCAL working tree, including uncommitted changes. No remote or Git command is used.",
			inputSchema: z.object({
				repository,
				path: z.string().max(1024),
				start: z.number().int().min(1).optional(),
				end: z.number().int().min(1).optional(),
			}).strict(),
			execute: async (input, { context }) => {
				let file = await location(root(context.repository.id, input.repository), input.path);
				if ((await stat(file)).size > MAX_BYTES) throw new Error("File exceeds 256 KiB.");
				let bytes = await readFile(file);
				if (bytes.length > MAX_BYTES || bytes.includes(0)) {
					throw new Error("File is binary or too large.");
				}
				let lines = bytes.toString("utf8").split("\n");
				let start = input.start ?? 1;
				let end = Math.min(input.end ?? start + 399, start + 399, lines.length);
				return {
					path: input.path,
					start,
					end,
					content: lines.slice(start - 1, end).map((line, i) => `${start + i}: ${line}`).join("\n"),
				};
			},
		}),
		list_repository_tree: tool({
			contextSchema,
			description:
				"List source files in a registered local checkout. Private configuration, dependency folders and symlinks are omitted.",
			inputSchema: z.object({
				repository,
				prefix: z.string().max(1024).optional(),
				limit: z.number().int().min(1).max(500).default(200),
			}).strict(),
			execute: async (input, { context }) => {
				let entries: { path: string; type: string }[] = [];
				for await (let path of files(root(context.repository.id, input.repository), input.prefix)) {
					if (entries.length === input.limit) return { entries, truncated: true };
					entries.push({ path, type: "blob" });
				}
				return { entries, truncated: entries.length >= input.limit };
			},
		}),
		search_repository: tool({
			contextSchema,
			description:
				"Find a literal source term in registered local files. Reads at most 5000 directory entries and 8 MiB per call; no regex, Git, shell or remote is executed.",
			inputSchema: z.object({
				repository,
				terms: z.string().min(1).max(200),
				limit: z.number().int().min(1).max(50).default(20),
			}).strict(),
			execute: async (input, { context, abortSignal }) => {
				let directory = root(context.repository.id, input.repository);
				let matches: { path: string; line: number; text: string }[] = [];
				let bytes = 0;
				for await (let path of files(directory)) {
					abortSignal?.throwIfAborted();
					let file = await location(directory, path);
					let size = (await stat(file)).size;
					if (size > MAX_BYTES) continue;
					if ((bytes += size) > 8 * 1024 * 1024) return { matches, truncated: true };
					let content = await readFile(file);
					if (content.length > MAX_BYTES || content.includes(0)) continue;
					let lines = content.toString("utf8").split("\n");
					for (let [i, text] of lines.entries()) {
						if (!text.includes(input.terms)) continue;
						matches.push({ path, line: i + 1, text: text.slice(0, 1000) });
						if (matches.length === input.limit) return { matches, truncated: true };
					}
				}
				return { matches, truncated: false };
			},
		}),
	};
}

export const LOCAL_PLANNER_TOOL_NAMES = [
	"prototype_local",
	"list_local_checkpoints",
	"apply_local_checkpoint",
	"verify_local_commit",
	"read_plan",
	"read_reference",
	"edit_plan",
	"open_decision",
	"open_decisions",
	"ask",
	"anchor_plan",
	"reply_comment",
	"list_children",
	"read_child",
	"edit_child",
	"anchor_child",
	"revise_open_decision",
	"read_repository_file",
	"list_repository_tree",
	"search_repository",
] as const;
