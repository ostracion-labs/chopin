import { afterEach, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Checkpoints } from "./checkpoints";

let directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function fixture() {
	let root = await mkdtemp(join(tmpdir(), "chopin-checkpoint-test-"));
	directories.push(root);
	let source = join(root, "checkout");
	await mkdir(source);
	const git = async (...args: string[]) => {
		let child = Bun.spawn(["git", "-C", source, ...args], {
			stdout: "pipe",
			stderr: "pipe",
			env: {
				PATH: process.env.PATH,
				HOME: root,
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_AUTHOR_NAME: "Test",
				GIT_AUTHOR_EMAIL: "test@example.com",
				GIT_COMMITTER_NAME: "Test",
				GIT_COMMITTER_EMAIL: "test@example.com",
			},
		});
		let output = await new Response(child.stdout).text();
		if (await child.exited) throw new Error(await new Response(child.stderr).text());
		return output;
	};
	await git("init");
	await writeFile(join(source, "source.txt"), "base\n");
	await git("add", ".");
	await git("commit", "-m", "base");
	let checkpoints = new Checkpoints(
		[{ id: "repo", name: "local/test", path: source }],
		join(root, "checkpoints"),
	);
	return { root, source, checkpoints, git };
}

test("copies preserve uncommitted source, seal alternatives, apply only human-selected files and require a real manual commit", async () => {
	let { source, checkpoints, git } = await fixture();
	await writeFile(join(source, "source.txt"), "human uncommitted\n");
	await writeFile(join(source, ".env"), "private");
	let a = await checkpoints.create("doc", "repo", "A", "test A");
	let b = await checkpoints.create("doc", "repo", "B", "test B");
	expect(await readFile(join(a.copy, "source.txt"), "utf8")).toBe("human uncommitted\n");
	expect(await Bun.file(join(a.copy, ".env")).exists()).toBe(false);
	expect(await Bun.file(join(a.copy, ".git")).exists()).toBe(false);
	await writeFile(join(a.copy, "source.txt"), "selected alternative\n");
	await checkpoints.seal(a.id, "Tests passed in A");
	await writeFile(join(a.copy, "source.txt"), "changed after seal\n");
	expect(await readFile(join(source, "source.txt"), "utf8")).toBe("human uncommitted\n");
	await expect(checkpoints.apply(a.id, "other-doc", ["decision"], "checkpoint")).rejects.toThrow();
	await expect(checkpoints.apply(a.id, "doc", [], "checkpoint")).rejects.toThrow();
	let head = await git("rev-parse", "HEAD");
	let index = await git("ls-files", "--stage");
	await checkpoints.apply(a.id, "doc", ["decision"], "checkpoint A");
	expect(await git("rev-parse", "HEAD")).toBe(head);
	expect(await git("ls-files", "--stage")).toBe(index);
	expect(await readFile(join(source, "source.txt"), "utf8")).toBe("selected alternative\n");
	expect(await readFile(join(b.copy, "source.txt"), "utf8")).toBe("human uncommitted\n");
	await expect(checkpoints.create("doc", "repo", "next", "next")).rejects.toThrow(
		"Commit or resolve",
	);
	await expect(checkpoints.verifyCommit(a.id)).rejects.toThrow("manually");
	await git("commit", "--allow-empty", "-m", "unrelated checkpoint");
	await expect(checkpoints.verifyCommit(a.id)).rejects.toThrow("does not contain");
	await git("add", "source.txt");
	await git("commit", "-m", "checkpoint A");
	expect((await checkpoints.verifyCommit(a.id)).status).toBe("committed");
	expect((await checkpoints.create("doc", "repo", "next", "next")).status).toBe("prototype");
});

test("original edits and symlink targets conflict before any selected file is overwritten", async () => {
	let { root, source, checkpoints } = await fixture();
	let record = await checkpoints.create("doc", "repo", "A", "test");
	await writeFile(join(record.copy, "source.txt"), "candidate");
	await checkpoints.seal(record.id, "done");
	await writeFile(join(source, "source.txt"), "concurrent human edit");
	await expect(checkpoints.apply(record.id, "doc", ["decision"], "A")).rejects.toThrow(
		"Original changed",
	);
	expect(await readFile(join(source, "source.txt"), "utf8")).toBe("concurrent human edit");
	await rm(join(source, "source.txt"));
	await symlink(join(root, "elsewhere"), join(source, "source.txt"));
	await expect(checkpoints.apply(record.id, "doc", ["decision"], "A")).rejects.toThrow(
		"regular file",
	);
});

test("executable-only changes survive checkpoint selection and commit verification", async () => {
	let { source, checkpoints, git } = await fixture();
	let record = await checkpoints.create("doc", "repo", "Executable", "Make script executable");
	await chmod(join(record.copy, "source.txt"), 0o755);
	let sealed = await checkpoints.seal(record.id, "Changed executable bit only");
	expect(sealed.files).toHaveLength(1);
	expect(await checkpoints.preview(record.id)).toContain("Sealed candidate:");
	await checkpoints.apply(record.id, "doc", ["decision"], "Mark executable");
	expect((await lstat(join(source, "source.txt"))).mode & 0o111).not.toBe(0);
	await git("add", "source.txt");
	await git("commit", "-m", "executable checkpoint");
	expect((await checkpoints.verifyCommit(record.id)).status).toBe("committed");
});

test("a restart recovers a completed application without repeating source writes", async () => {
	let { root, source, checkpoints, git } = await fixture();
	let record = await checkpoints.create("doc", "repo", "Recover", "test");
	await writeFile(join(record.copy, "source.txt"), "selected after restart");
	await checkpoints.seal(record.id, "done");
	record = await checkpoints.apply(record.id, "doc", ["decision"], "checkpoint");
	record.status = "applying";
	await writeFile(join(root, "checkpoints", record.id, "checkpoint.json"), JSON.stringify(record));
	await git("add", "source.txt");
	await git("commit", "-m", "human recovery checkpoint");
	let reopened = new Checkpoints(
		[{ id: "repo", name: "local/test", path: source }],
		join(root, "checkpoints"),
	);
	expect((await reopened.verifyCommit(record.id)).status).toBe("committed");
	expect(await readFile(join(source, "source.txt"), "utf8")).toBe("selected after restart");
});

test("checking out an older matching commit cannot impersonate a new manual checkpoint", async () => {
	let { source, checkpoints, git } = await fixture();
	let older = (await git("rev-parse", "HEAD")).trim();
	await writeFile(join(source, "source.txt"), "current baseline");
	await git("add", ".");
	await git("commit", "-m", "current");
	let record = await checkpoints.create("doc", "repo", "Older content", "test");
	await writeFile(join(record.copy, "source.txt"), "base\n");
	await checkpoints.seal(record.id, "done");
	await checkpoints.apply(record.id, "doc", ["decision"], "checkpoint");
	await git("checkout", "--force", "--detach", older);
	await expect(checkpoints.verifyCommit(record.id)).rejects.toThrow("manually");
});
