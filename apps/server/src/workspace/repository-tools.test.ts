import { afterEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localRepositoryTools } from "./repository-tools";

let directories: string[] = [];
afterEach(() => {
	for (let directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
	let root = mkdtempSync(join(tmpdir(), "chopin-source-tools-"));
	directories.push(root);
	let first = join(root, "first");
	let second = join(root, "second");
	mkdirSync(first);
	mkdirSync(second);
	writeFileSync(join(first, "source.ts"), "uncommitted source\nsecond line\n");
	writeFileSync(join(second, "other.ts"), "companion source\n");
	let tools = localRepositoryTools([{ id: "one", name: "local/one", path: first }, {
		id: "two",
		name: "local/two",
		path: second,
	}]);
	let options = { context: { repository: { id: "one" } }, toolCallId: "read", messages: [] };
	return { root, first, second, tools, options };
}

it("reads uncommitted files and explicitly registered companion repositories without Git", async () => {
	let { tools, options } = fixture();
	expect(await tools.read_repository_file.execute!({ path: "source.ts" }, options)).toMatchObject({
		content: "1: uncommitted source\n2: second line\n3: ",
	});
	expect(
		await tools.read_repository_file.execute!(
			{ repository: "local/two", path: "other.ts" },
			options,
		),
	).toMatchObject({ content: "1: companion source\n2: " });
	await expect(
		Promise.resolve(
			tools.read_repository_file.execute!(
				{ repository: "local/missing", path: "other.ts" },
				options,
			),
		),
	).rejects.toThrow("Register");
	expect(await tools.search_repository.execute!({ terms: "source", limit: 20 }, options))
		.toMatchObject({ matches: [{ path: "source.ts", line: 1, text: "uncommitted source" }] });
});

it("rejects traversal and symlinks to outside files or private Git/configuration data", async () => {
	let { root, first, tools, options } = fixture();
	writeFileSync(join(root, "outside"), "private");
	mkdirSync(join(first, ".git"));
	writeFileSync(join(first, ".git/config"), "must not read or execute");
	writeFileSync(join(first, ".env"), "secret");
	symlinkSync(join(root, "outside"), join(first, "escape"));
	symlinkSync(join(first, ".git/config"), join(first, "config-link"));
	for (
		let path of [
			"../outside",
			join(root, "outside"),
			".git/config",
			".env",
			"escape",
			"config-link",
		]
	) {
		await expect(Promise.resolve(tools.read_repository_file.execute!({ path }, options))).rejects
			.toThrow();
	}
	expect(await tools.list_repository_tree.execute!({ limit: 100 }, options)).toMatchObject({
		entries: [{ path: "source.ts", type: "blob" }],
	});
});
