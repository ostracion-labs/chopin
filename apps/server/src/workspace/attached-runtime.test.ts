import { expect, test } from "bun:test";
import { attachedRuntime } from "./attached-runtime";

test("manual attachment correlates requests, keeps a single bridge lease and closes pending work on disconnect", async () => {
	let id = crypto.randomUUID();
	let runtime = attachedRuntime(id);
	let signal = new AbortController().signal;
	try {
		let request = runtime.request("initialize", { clientInfo: { name: "chopin" } });
		let sent = await runtime.poll("owner", signal);
		expect(sent[0]!.method).toBe("initialize");
		await expect(runtime.poll("other", signal)).rejects.toThrow("Another bridge");
		runtime.receive("owner", { id: sent[0]!.id, result: { ready: true } });
		expect(await request).toEqual({ ready: true });
		let events: string[] = [];
		runtime.watch(event => {
			if (event.method) events.push(event.method);
		});
		runtime.receive("owner", {
			id: "approval",
			method: "item/commandExecution/requestApproval",
			params: {},
		});
		expect(events).toContain("item/commandExecution/requestApproval");
		runtime.reply("approval", { decision: "decline" });
		expect((await runtime.poll("owner", signal))[0]).toEqual({
			id: "approval",
			result: { decision: "decline" },
		});
		let pending = runtime.request("thread/start", {});
		runtime.close();
		await expect(pending).rejects.toThrow("disconnected");
		expect(events).toContain("chopin/disconnected");
		let fresh = attachedRuntime(id);
		expect(fresh).not.toBe(runtime);
		fresh.close();
	} finally {
		runtime.close();
	}
});
