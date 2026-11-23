import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
	copyFile,
	lstat,
	mkdir,
	readdir,
	readFile,
	realpath,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { localStateDirectory } from "./ai-config";
import { committedBlob, followsCheckpoint, localHead } from "./git-read";
import type { WorkspaceRepository } from "./config";
import type { LocalCheckpoint } from "@chopin/protocol/local-ai";

const OMIT = new Set([
	".git",
	"node_modules",
	"bin",
	"obj",
	"dist",
	".env",
	".ssh",
	".aws",
	".codex",
]);
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const ID = /^[0-9a-f-]{36}$/;
type Record = LocalCheckpoint & {
	baseline: { path: string; hash: string; mode: number }[];
	report?: string;
	decisions?: string[];
};

/** Durable copy -> human selection -> original files -> verified manual commit checkpoints. */
export class Checkpoints {
	#queue = Promise.resolve();
	constructor(
		readonly repositories: WorkspaceRepository[],
		readonly directory = join(localStateDirectory(), "checkpoints"),
	) {}
	async #exclusive<T>(work: () => Promise<T>): Promise<T> {
		let operation = this.#queue.then(work);
		this.#queue = operation.then(() => {}, () => {});
		return operation;
	}
	#folder(id: string) {
		if (!ID.test(id)) throw new Error("Invalid checkpoint ID");
		return join(this.directory, id);
	}
	async #save(record: Record) {
		let folder = this.#folder(record.id);
		await mkdir(folder, { recursive: true, mode: 0o700 });
		let tmp = join(folder, `${crypto.randomUUID()}.tmp`);
		await writeFile(tmp, JSON.stringify(record), { mode: 0o600 });
		await rename(tmp, join(folder, "checkpoint.json"));
	}
	async get(id: string): Promise<Record> {
		let record = JSON.parse(
			await readFile(join(this.#folder(id), "checkpoint.json"), "utf8"),
		) as Record;
		if (record.id !== id) throw new Error("Invalid checkpoint record");
		return record;
	}
	async list(documentId?: string): Promise<Record[]> {
		let names: string[];
		try {
			names = await readdir(this.directory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		let records = await Promise.all(names.filter(name => ID.test(name)).map(id => this.get(id)));
		return records.filter(record => !documentId || record.documentId === documentId);
	}
	async preview(id: string): Promise<string> {
		let record = await this.get(id);
		let sections = [`Sealed candidate: ${join(this.#folder(id), "candidate")}`];
		let remaining = 20_000;
		for (let file of record.files ?? []) {
			if (remaining <= 0) {
				sections.push("Preview truncated. Review the sealed candidate directory before approving.");
				break;
			}
			let sides = [];
			for (
				let [name, folder, present] of [["Before", "base", file.before], [
					"After",
					"candidate",
					file.after,
				]] as const
			) {
				let bytes = present ? await readFile(join(this.#folder(id), folder, file.path)) : null;
				let text = bytes
					? bytes.includes(0) ? `[binary file, ${bytes.length} bytes]` : bytes.toString("utf8")
					: "[absent]";
				let retained = text.slice(0, Math.min(remaining, 4_000));
				remaining -= retained.length;
				sides.push(
					`${name}: ${JSON.stringify(retained)}${
						retained.length < text.length ? " [truncated]" : ""
					}`,
				);
			}
			sections.push(
				`${file.path} (mode ${file.beforeMode?.toString(8) ?? "absent"} -> ${
					file.afterMode?.toString(8) ?? "absent"
				})\n${sides.join("\n")}`,
			);
		}
		return sections.join("\n\n");
	}
	async #files(directory: string): Promise<{ path: string; hash: string; mode: number }[]> {
		let files: { path: string; hash: string; mode: number }[] = [];
		let bytes = 0;
		let entries = 0;
		const walk = async (base: string) => {
			for (let entry of await readdir(join(directory, base), { withFileTypes: true })) {
				if (++entries > 25_000) throw new Error("Prototype copy exceeds 25000 entries");
				if (OMIT.has(entry.name) || entry.name.startsWith(".env") || entry.isSymbolicLink()) {
					continue;
				}
				let path = base ? `${base}/${entry.name}` : entry.name;
				if (entry.isDirectory()) await walk(path);
				else if (entry.isFile()) {
					let info = await lstat(join(directory, path));
					bytes += info.size;
					if (bytes > 256 * 1024 * 1024 || info.size > 8 * 1024 * 1024) {
						throw new Error("Prototype source exceeds its 256 MiB copy or 8 MiB file limit");
					}
					let content = await readFile(join(directory, path));
					files.push({ path, hash: digest(content), mode: info.mode & 0o777 });
				}
			}
		};
		await walk("");
		return files;
	}
	async #copy(from: string, to: string, files: { path: string }[]) {
		await mkdir(to, { recursive: true, mode: 0o700 });
		for (let file of files) {
			await mkdir(dirname(join(to, file.path)), { recursive: true });
			await copyFile(join(from, file.path), join(to, file.path), constants.COPYFILE_EXCL);
		}
	}
	async create(
		documentId: string,
		repositoryId: string,
		name: string,
		goal: string,
	): Promise<Record> {
		return this.#exclusive(async () => {
			let repository = this.repositories.find(item => item.id === repositoryId);
			if (!repository) throw new Error("Repository is not registered");
			if (
				(await this.list()).some(record =>
					record.repositoryId === repositoryId
					&& ["applying", "awaiting-commit", "conflict"].includes(record.status)
				)
			) throw new Error("Commit or resolve the current checkpoint before starting the next one");
			let id = crypto.randomUUID();
			let folder = this.#folder(id);
			let baseline = await this.#files(repository.path);
			let record: Record = {
				id,
				documentId,
				repositoryId,
				name,
				goal,
				copy: join(folder, "working"),
				status: "prototype",
				baseHead: await localHead(repository.path),
				created: new Date().toISOString(),
				baseline,
			};
			await this.#copy(repository.path, join(folder, "base"), baseline);
			await this.#copy(join(folder, "base"), record.copy, baseline);
			await this.#save(record);
			return record;
		});
	}
	async seal(id: string, report: string): Promise<Record> {
		return this.#exclusive(async () => {
			let record = await this.get(id);
			if (record.status !== "prototype" || record.files) {
				throw new Error("This prototype has already been sealed");
			}
			let files = await this.#files(record.copy);
			await this.#copy(record.copy, join(this.#folder(id), "candidate"), files);
			let before = new Map(record.baseline.map(file => [file.path, file]));
			let after = new Map(files.map(file => [file.path, file]));
			record.files = [...new Set([...before.keys(), ...after.keys()])].flatMap(path => {
				let prior = before.get(path), next = after.get(path);
				return prior?.hash === next?.hash && prior?.mode === next?.mode
					? []
					: [{
						path,
						before: prior?.hash ?? null,
						after: next?.hash ?? null,
						beforeMode: prior?.mode ?? null,
						afterMode: next?.mode ?? null,
					}];
			});
			record.report = report;
			await this.#save(record);
			return record;
		});
	}
	async #target(root: string, path: string): Promise<string> {
		if (
			isAbsolute(path)
			|| path.split(/[\\/]/).some(part =>
				!part || part === ".." || OMIT.has(part) || part.startsWith(".env")
			)
		) throw new Error("Unsafe checkpoint path");
		let target = resolve(root, path);
		let parent = dirname(target);
		while (true) {
			try {
				let canonical = await realpath(parent);
				let rel = relative(root, canonical);
				if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
					throw new Error("A checkpoint path leaves its checkout");
				}
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				parent = dirname(parent);
			}
		}
		try {
			if (!(await lstat(target)).isFile()) {
				throw new Error("A checkpoint target is not a regular file");
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		return target;
	}
	async apply(
		id: string,
		documentId: string,
		decisions: string[],
		commitMessage: string,
	): Promise<Record> {
		return this.#exclusive(async () => {
			let record = await this.get(id);
			if (
				record.documentId !== documentId || !decisions.length || record.status !== "prototype"
				|| !record.files?.length
			) throw new Error("A sealed prototype and a saved human selection are required");
			let repository = this.repositories.find(item => item.id === record.repositoryId)!;
			if (
				(await this.list()).some(item =>
					item.id !== id && item.repositoryId === record.repositoryId
					&& ["applying", "awaiting-commit", "conflict"].includes(item.status)
				)
			) throw new Error("Another checkpoint is waiting for its manual commit");
			for (let file of record.files) {
				let target = await this.#target(repository.path, file.path);
				let hash: string | null;
				try {
					hash = digest(await readFile(target));
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					hash = null;
				}
				if (
					hash !== file.before
					|| file.beforeMode != null && (await lstat(target)).mode % 512 !== file.beforeMode
				) {
					throw new Error(
						`Original changed since this prototype: ${file.path}. Refresh the prototype; no original files were changed.`,
					);
				}
				if (
					file.after
					&& digest(await readFile(join(this.#folder(id), "candidate", file.path))) !== file.after
				) throw new Error("The sealed candidate changed");
			}
			record.baseHead = await localHead(repository.path);
			record.status = "applying";
			record.decisions = decisions;
			record.commitMessage = commitMessage;
			await this.#save(record);
			try {
				for (let file of record.files) {
					let target = await this.#target(repository.path, file.path);
					if (!file.after) await unlink(target);
					else {
						await mkdir(dirname(target), { recursive: true });
						let temporary = target + `.chopin-${crypto.randomUUID()}`;
						await copyFile(
							join(this.#folder(id), "candidate", file.path),
							temporary,
							constants.COPYFILE_EXCL,
						);
						await rename(temporary, target);
					}
				}
				record.status = "awaiting-commit";
				await this.#save(record);
				return record;
			} catch (error) {
				record.status = "conflict";
				await this.#save(record);
				throw error;
			}
		});
	}
	async verifyCommit(id: string): Promise<Record> {
		return this.#exclusive(async () => {
			let record = await this.get(id);
			let repository = this.repositories.find(item => item.id === record.repositoryId)!;
			if (["applying", "conflict"].includes(record.status)) {
				let before = true, after = true;
				for (let file of record.files ?? []) {
					let target = await this.#target(repository.path, file.path);
					let hash: string | null = null, mode: number | null = null;
					try {
						hash = digest(await readFile(target));
						mode = (await lstat(target)).mode & 0o777;
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					}
					before &&= hash === file.before && (file.beforeMode == null || mode === file.beforeMode);
					after &&= hash === file.after && (file.afterMode == null || mode === file.afterMode);
				}
				if (!before && !after) {
					throw new Error(
						"Interrupted application: manually finish the sealed candidate or restore every selected file from its preserved baseline, then verify again. No files were changed by this check.",
					);
				}
				record.status = after ? "awaiting-commit" : "prototype";
				await this.#save(record);
			}
			if (record.status !== "awaiting-commit") {
				throw new Error("This checkpoint is not waiting for a manual commit");
			}
			let head = await localHead(repository.path);
			if (!await followsCheckpoint(repository.path, record.baseHead, head)) {
				throw new Error(
					"Commit this checkpoint manually first. Chopin never commits or pushes for you.",
				);
			}
			for (let file of record.files!) {
				let expected: string | null = null;
				if (file.after) {
					let bytes = await readFile(join(this.#folder(id), "candidate", file.path));
					expected = createHash(head.length === 64 ? "sha256" : "sha1").update(
						`blob ${bytes.length}\0`,
					).update(bytes).digest("hex");
				}
				let committed = await committedBlob(repository.path, file.path);
				if (
					(committed?.hash ?? null) !== expected
					|| file.afterMode != null
						&& committed?.mode !== (file.afterMode & 0o111 ? "100755" : "100644")
				) {
					throw new Error(
						`The current commit does not contain the selected checkpoint: ${file.path}`,
					);
				}
			}
			record.status = "committed";
			record.commit = head;
			await this.#save(record);
			return record;
		});
	}
}
