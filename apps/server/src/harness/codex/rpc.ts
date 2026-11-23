import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";

export type Message = {
	id?: number | string;
	method?: string;
	params?: Record<string, unknown>;
	result?: unknown;
	error?: { message: string };
};
export interface CodexRpc {
	request(method: string, params: Record<string, unknown>): Promise<Record<string, any>>;
	reply(id: number | string, result: unknown): void;
	notify(method: string): void;
	watch(listener: (message: Message) => void): () => void;
	closed: Promise<void>;
	close(): void;
}

/** One private stdio connection. A transport failure rejects every outstanding RPC. */
export class Rpc implements CodexRpc {
	#process: ChildProcessWithoutNullStreams;
	#next = 0;
	#pending = new Map<
		number,
		{
			resolve: (value: any) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	#listeners = new Set<(message: Message) => void>();
	#error?: Error;
	readonly closed: Promise<void>;

	constructor(command: string, args: string[], cwd: string) {
		let env = Object.fromEntries(
			Object.entries(process.env).filter(([name]) =>
				[
					"HOME",
					"PATH",
					"USER",
					"LOGNAME",
					"SHELL",
					"LANG",
					"LC_ALL",
					"CODEX_HOME",
					"XDG_CONFIG_HOME",
					"XDG_DATA_HOME",
					"XDG_STATE_HOME",
					"XDG_CACHE_HOME",
					"HTTP_PROXY",
					"HTTPS_PROXY",
					"NO_PROXY",
					"http_proxy",
					"https_proxy",
					"no_proxy",
					"SSL_CERT_FILE",
					"SSL_CERT_DIR",
					"NODE_EXTRA_CA_CERTS",
				].includes(name)
			),
		);
		this.#process = spawn(command, args, { cwd, stdio: "pipe", env });
		// Never log raw Codex stderr: a configured provider or MCP may include credentials in it.
		this.#process.stderr.resume();
		this.#process.stdin.on("error", () => this.#fail(new Error("The Codex connection closed.")));
		let lines = createInterface({ input: this.#process.stdout });
		lines.on("line", line => {
			if (Buffer.byteLength(line) > 16 * 1024 * 1024) return this.close();
			let message: Message;
			try {
				message = JSON.parse(line);
			} catch {
				return this.close();
			}
			if (message.id !== undefined && !message.method) {
				let pending = this.#pending.get(Number(message.id));
				if (!pending) return;
				this.#pending.delete(Number(message.id));
				clearTimeout(pending.timer);
				if (message.error) pending.reject(new Error(message.error.message));
				else pending.resolve(message.result);
			} else for (let listener of this.#listeners) listener(message);
		});
		this.closed = new Promise(resolve => {
			let finish = () => {
				this.#fail(
					new Error(
						"Codex stopped. Send a new message to reconnect; interrupted work is not replayed.",
					),
				);
				lines.close();
				resolve();
			};
			this.#process.once("error", finish);
			this.#process.once("exit", finish);
		});
	}

	#fail(error: Error): void {
		if (this.#error) return;
		this.#error = error;
		for (let pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.#pending.clear();
		for (let listener of this.#listeners) listener({ method: "chopin/disconnected" });
	}

	#send(message: unknown): void {
		if (this.#error) throw this.#error;
		this.#process.stdin.write(JSON.stringify(message) + "\n");
	}

	request(method: string, params: Record<string, unknown>): Promise<Record<string, any>> {
		return new Promise((resolve, reject) => {
			let id = ++this.#next;
			let timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new Error(`Codex ${method} timed out.`));
			}, 25_000);
			this.#pending.set(id, { resolve, reject, timer });
			try {
				this.#send({ id, method, params });
			} catch (error) {
				clearTimeout(timer);
				this.#pending.delete(id);
				reject(error);
			}
		});
	}

	reply(id: number | string, result: unknown): void {
		this.#send({ id, result });
	}
	notify(method: string): void {
		this.#send({ method });
	}
	watch(listener: (message: Message) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	close(): void {
		this.#fail(new Error("The Codex connection closed."));
		this.#process.kill("SIGTERM");
		let timer = setTimeout(() => this.#process.kill("SIGKILL"), 2000);
		void this.closed.then(() => clearTimeout(timer));
	}
}
