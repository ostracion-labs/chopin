import type { CodexRpc, Message } from "../harness/codex/rpc";

/** Authenticated local long-poll transport for a manually started runtime bridge. */
class AttachedRuntime implements CodexRpc {
	#next = 0;
	#queue: Message[] = [];
	#pending = new Map<
		number,
		{
			resolve: (value: any) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	#listeners = new Set<(value: Message) => void>();
	#wake?: () => void;
	#ended = false;
	#end!: () => void;
	#lease?: string;
	#expiry?: ReturnType<typeof setTimeout>;
	readonly closed = new Promise<void>(resolve => {
		this.#end = resolve;
	});
	constructor(readonly id: string) {}
	request(method: string, params: Record<string, unknown>): Promise<Record<string, any>> {
		if (this.#ended) return Promise.reject(new Error("The attached runtime disconnected"));
		return new Promise((resolve, reject) => {
			let id = ++this.#next;
			let timer = setTimeout(() => {
				this.close();
				reject(new Error("The attached AI did not answer. Start its connection and retry."));
			}, 25_000);
			this.#pending.set(id, { resolve, reject, timer });
			this.#queue.push({ id, method, params });
			this.#wake?.();
		});
	}
	reply(id: string | number, result: unknown) {
		this.#queue.push({ id, result });
		this.#wake?.();
	}
	notify(method: string) {
		this.#queue.push({ method });
		this.#wake?.();
	}
	watch(listener: (value: Message) => void) {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}
	async poll(lease: string, signal: AbortSignal): Promise<Message[]> {
		if (this.#lease && this.#lease !== lease) {
			throw new Error("Another bridge already holds this connection");
		}
		if (this.#wake) throw new Error("This bridge already has a pending poll");
		this.#lease = lease;
		if (this.#expiry) clearTimeout(this.#expiry);
		this.#expiry = setTimeout(() => this.close(), 45_000);
		this.#expiry.unref();
		if (!this.#queue.length && !this.#ended && !signal.aborted) {
			await new Promise<void>(resolve => {
				let done = () => {
					clearTimeout(timer);
					signal.removeEventListener("abort", done);
					this.#wake = undefined;
					resolve();
				};
				let timer = setTimeout(done, 15_000);
				this.#wake = done;
				signal.addEventListener("abort", done, { once: true });
			});
		}
		if (this.#ended) throw new Error("The connection ended. Reconnect the bridge.");
		return this.#queue.splice(0);
	}
	receive(lease: string, message: Message) {
		if (this.#lease !== lease || this.#ended) {
			throw new Error("The bridge does not own this connection");
		}
		if (message.id !== undefined && !message.method) {
			let pending = this.#pending.get(Number(message.id));
			if (pending) {
				this.#pending.delete(Number(message.id));
				clearTimeout(pending.timer);
				if (message.error) pending.reject(new Error(message.error.message));
				else pending.resolve(message.result);
			}
		} else for (let listener of this.#listeners) listener(message);
	}
	close() {
		if (this.#ended) return;
		this.#ended = true;
		if (this.#expiry) clearTimeout(this.#expiry);
		this.#wake?.();
		for (let pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("The attached runtime disconnected"));
		}
		this.#pending.clear();
		for (let listener of this.#listeners) listener({ method: "chopin/disconnected" });
		this.#end();
		attached.delete(this.id);
	}
}
const attached = new Map<string, AttachedRuntime>();
export function attachedRuntime(id: string): AttachedRuntime {
	let runtime = attached.get(id);
	if (!runtime) {
		runtime = new AttachedRuntime(id);
		attached.set(id, runtime);
	}
	return runtime;
}
