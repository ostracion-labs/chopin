import { createHash, timingSafeEqual } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export type WorkspaceRepository = {
	/** A local display/route alias, independent of a Git remote or GitLab namespace. */
	name: string;
	path: string;
	id: string;
};

export type WorkspaceConfig = {
	token: string;
	repositories: WorkspaceRepository[];
};

const NAME = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}\/[a-z0-9][a-z0-9._-]{0,99}$/i;

/** Only explicitly registered directories are visible. No remote is resolved or contacted. */
export function workspaceRepositories(raw: string | undefined): WorkspaceRepository[] {
	let values: unknown;
	try {
		values = JSON.parse(raw ?? "[]");
	} catch {
		throw new Error("CHOPIN_WORKSPACES must be a JSON array of {name, path} records");
	}
	if (!Array.isArray(values) || values.length > 200) {
		throw new Error("CHOPIN_WORKSPACES must contain at most 200 checkouts");
	}
	let names = new Set<string>();
	let paths = new Set<string>();
	return values.map((value: unknown) => {
		if (!value || typeof value !== "object") throw new Error("Invalid workspace checkout");
		let record = value as Record<string, unknown>;
		if (
			typeof record.name !== "string" || !NAME.test(record.name)
			|| typeof record.path !== "string" || !isAbsolute(record.path)
			|| Object.keys(record).some(key => key !== "name" && key !== "path")
		) {
			throw new Error(
				"Each workspace checkout needs a name like local/project and an absolute path",
			);
		}
		let path = realpathSync(record.path);
		if (!statSync(path).isDirectory()) throw new Error("A workspace checkout must be a directory");
		// A linked worktree has a .git file. Neither it nor repository configuration is executed.
		let git = statSync(join(path, ".git"));
		if (!git.isDirectory() && !git.isFile()) throw new Error("A workspace checkout needs .git");
		let name = record.name.toLowerCase();
		if (names.has(name) || paths.has(path)) {
			throw new Error("Workspace names and paths must be unique");
		}
		names.add(name);
		paths.add(path);
		return {
			name,
			path,
			id: `workspace:${createHash("sha256").update(path).digest("hex")}`,
		};
	});
}

export function workspaceToken(raw: string | undefined): string {
	if (!raw || !/^[a-zA-Z0-9_-]{43,128}$/.test(raw)) {
		throw new Error(
			"CHOPIN_WORKSPACE_TOKEN must be a random token of at least 43 URL-safe characters",
		);
	}
	return raw;
}

export function matchesWorkspaceToken(expected: string, actual: string): boolean {
	let left = createHash("sha256").update(expected).digest();
	let right = createHash("sha256").update(actual).digest();
	return timingSafeEqual(left, right);
}
