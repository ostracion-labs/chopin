import { spawn } from "node:child_process";

/** Fixed, read-only Git queries. No shell, hooks, filters, lazy fetch, credentials or transport. */
async function git(directory: string, args: string[]): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		let child = spawn("git", [
			"--literal-pathspecs",
			"--no-pager",
			"--no-optional-locks",
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"core.fsmonitor=false",
			"-c",
			"protocol.allow=never",
			"-C",
			directory,
			...args,
		], {
			env: {
				PATH: process.env.PATH,
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_TERMINAL_PROMPT: "0",
				GIT_NO_LAZY_FETCH: "1",
				GIT_NO_REPLACE_OBJECTS: "1",
				GIT_ALLOW_PROTOCOL: "",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let chunks: Buffer[] = [];
		let size = 0;
		let timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error("Local Git read timed out"));
		}, 5000);
		child.stdout.on("data", chunk => {
			size += chunk.length;
			if (size > 1024 * 1024) {
				child.kill();
				reject(new Error("Git read exceeds its limit"));
			} else chunks.push(chunk);
		});
		child.stderr.resume();
		child.once("error", error => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", code => {
			clearTimeout(timer);
			if (code === 0) resolve(Buffer.concat(chunks));
			else reject(new Error("Local Git history is unavailable"));
		});
	});
}
export async function localHead(directory: string): Promise<string> {
	let head = (await git(directory, ["rev-parse", "--verify", "HEAD"])).toString("utf8").trim();
	if (!/^[0-9a-f]{40,64}$/.test(head)) throw new Error("Invalid local Git HEAD");
	return head;
}

export async function followsCheckpoint(
	directory: string,
	base: string,
	head: string,
): Promise<boolean> {
	if (!/^[0-9a-f]{40,64}$/.test(base) || base === head) return false;
	try {
		await git(directory, ["merge-base", "--is-ancestor", base, head]);
		return true;
	} catch {
		return false;
	}
}
export async function committedBlob(
	directory: string,
	path: string,
): Promise<{ hash: string; mode: string } | null> {
	let data = (await git(directory, ["ls-tree", "-z", "HEAD", "--", path])).toString("utf8");
	if (!data) return null;
	let match = /^(\d+) blob ([0-9a-f]{40,64})\t/.exec(data);
	if (!match) throw new Error("The committed path is not a regular file");
	return { mode: match[1]!, hash: match[2]! };
}
