import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { e2ePort } from "./ports";
import { ROOT } from "./servers";

const ORIGIN = `http://127.0.0.1:${e2ePort(8791)}`;
const BASE_ENV = {
	...process.env,
	AUTH_MODE: "local",
	DEMO_PERSONAS: "off",
	APP_ORIGIN: ORIGIN,
	SERVER_HOST: "127.0.0.1",
	PORT: String(e2ePort(8791)),
	DATABASE_URL: process.env.E2E_DATABASE_URL_3!,
	GITHUB_APP_SLUG: "chopin-e2e",
	GITHUB_APP_CLIENT_ID: "e2e",
	GITHUB_APP_CLIENT_SECRET: "",
	GITHUB_ALLOWED_USERS: "",
	GITHUB_ALLOWED_ORGANIZATIONS: "",
	SESSION_ENCRYPTION_KEY: process.env.SESSION_ENCRYPTION_KEY!,
	AGENT: "off",
};

let processes: ReturnType<typeof spawn>[] = [];
let directories: string[] = [];

// Both modes use the same disposable database and application port.
test.describe.configure({ mode: "default" });

async function stop(child: ReturnType<typeof spawn>) {
	if (child.exitCode !== null || child.pid === undefined) {
		processes = processes.filter(value => value !== child);
		return;
	}
	let exit = new Promise<void>(resolve => child.once("close", () => resolve()));
	process.kill(-child.pid!, "SIGTERM");
	await exit;
	processes = processes.filter(value => value !== child);
}

async function server(directory: string, unavailable = false, extra: Record<string, string> = {}) {
	let child = spawn(process.execPath, [
		"--preload",
		"./e2e/secrets.ts",
		"--preload",
		"./e2e/github.ts",
		"apps/server/src/main.ts",
	], {
		cwd: ROOT,
		detached: true,
		env: {
			...BASE_ENV,
			CHOPIN_LOCAL_CREDENTIALS_DIR: join(directory, "config"),
			E2E_FAKE_VAULT_DIR: join(directory, "fake-vault"),
			E2E_DEVICE_APPROVAL_FILE: join(directory, "approval"),
			E2E_FAKE_VAULT_UNAVAILABLE: unavailable ? "1" : "0",
			...extra,
		},
		stdio: ["ignore", "ignore", "pipe"],
	});
	let errors = "";
	child.stderr?.on("data", chunk => {
		errors += String(chunk).slice(-2_000);
		if (process.env.E2E_CODEX_DEBUG && extra.CHOPIN_MODE === "workspace") {
			process.stderr.write(String(chunk));
		}
	});
	processes.push(child);
	for (let index = 0; index < 150; index++) {
		if (child.exitCode !== null) {
			let safe = errors.replace(/(?:ghu_|ghr_)[A-Za-z0-9_-]+/g, "<redacted>")
				.replace(/postgres(?:ql)?:\/\/[^\s]+/g, "<database-url>");
			throw new Error(`auth test server exited with ${child.exitCode}: ${safe.slice(-800)}`);
		}
		try {
			let response = await fetch(`${ORIGIN}/api/session`);
			if (response.ok) return child;
		} catch { /* Server has not bound yet. */ }
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	throw new Error("auth test server did not become ready");
}

test.afterEach(async () => {
	for (let child of processes) await stop(child);
	for (let directory of directories) await rm(directory, { recursive: true, force: true });
	processes = [];
	directories = [];
});

test("hosted sign-in survives process replacement and logout survives another restart", async ({ page, browser }) => {
	test.setTimeout(60_000);
	let directory = await mkdtemp(join(tmpdir(), "chopin-hosted-e2e-"));
	directories.push(directory);
	let hosted = { AUTH_MODE: "hosted", GITHUB_APP_CLIENT_SECRET: "e2e" };
	let child = await server(directory, false, hosted);
	await page.goto(ORIGIN);
	let login = page.getByRole("link", { name: "Continue with GitHub" });
	await expect(login).toBeVisible();
	let started = await page.request.get(new URL((await login.getAttribute("href"))!, ORIGIN).href, {
		maxRedirects: 0,
	});
	expect(started.status()).toBe(302);
	let state = new URL(started.headers().location!).searchParams.get("state")!;
	await page.goto(
		`${ORIGIN}/auth/github/callback?code=e2e-restarting&state=${encodeURIComponent(state)}`,
	);
	await expect(page.getByRole("button", { name: "restarting", exact: true })).toBeVisible();
	let original = await (await page.request.get(`${ORIGIN}/api/session`)).json();
	let cookie = (await page.context().cookies()).find(value => value.name === "chopin_session")!;
	expect(cookie.httpOnly).toBe(true);
	await stop(child);
	child = await server(directory, false, hosted);
	await page.reload();
	await expect(page.getByRole("button", { name: "restarting", exact: true })).toBeVisible();
	expect(await (await page.request.get(`${ORIGIN}/api/session`)).json()).toEqual(original);
	expect((await page.context().cookies()).find(value => value.name === cookie.name)?.value).toBe(
		cookie.value,
	);
	let outsider = await browser.newContext();
	try {
		expect(await (await outsider.request.get(`${ORIGIN}/api/session`)).json()).toMatchObject({
			user: null,
		});
	} finally {
		await outsider.close();
	}
	await expect(page.getByRole("textbox", { name: "Search repositories" })).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("button", { name: "Close Add project" })).toHaveCount(0);
	await page.getByRole("button", { name: "restarting", exact: true }).click();
	await page.getByRole("menuitem", { name: "Sign out" }).click();
	await expect(page.getByText("Open your workspace")).toBeVisible();
	await stop(child);
	await server(directory, false, hosted);
	await page.context().addCookies([cookie]);
	await page.reload();
	await expect(page.getByText("Open your workspace")).toBeVisible();
});

test("local device approval, backend fallback, restart and logout", async ({ page, browser, request }) => {
	test.setTimeout(120_000);
	let directory = await mkdtemp(join(tmpdir(), "chopin-local-e2e-"));
	directories.push(directory);
	let child = await server(directory);
	await page.goto(ORIGIN);
	await expect(page.getByText("Open your workspace")).toBeVisible();
	await expect(page.getByRole("checkbox")).toHaveCount(0);
	await page.getByRole("button", { name: /sign in|device|github/i }).first().click();
	let instruction = page.getByText(/Enter one-time code:/);
	await expect(instruction).toBeVisible();
	await expect(page.getByRole("checkbox")).toHaveCount(0);
	let code = (await instruction.textContent())!.match(/E2E-\d{4}/)![0]!;
	await expect(page.getByRole("link", { name: "https://github.com/login/device" })).toBeVisible();
	let cookies = await page.context().cookies();
	let attempt = cookies.find(value => value.name.startsWith("chopin_local_attempt"))!;
	expect(attempt.httpOnly).toBe(true);
	let outsider = await browser.newContext();
	let outsiderResponse = await outsider.request.post(`${ORIGIN}/auth/device/complete`, {
		headers: { origin: ORIGIN },
	});
	expect(await outsiderResponse.json()).toMatchObject({ status: "cancelled" });
	let outsiderConsent = await outsider.request.post(`${ORIGIN}/auth/device/consent`, {
		headers: { origin: ORIGIN },
		data: { accept: true },
	});
	expect(await outsiderConsent.json()).toMatchObject({ status: "cancelled" });
	let wrongOrigin = await request.post(`${ORIGIN}/auth/device/complete`, {
		headers: { origin: "http://attacker.invalid", cookie: `${attempt.name}=${attempt.value}` },
	});
	expect(wrongOrigin.status()).toBe(403);
	let wrongConsent = await request.post(`${ORIGIN}/auth/device/consent`, {
		headers: { origin: "http://attacker.invalid", cookie: `${attempt.name}=${attempt.value}` },
		data: { accept: true },
	});
	expect(wrongConsent.status()).toBe(403);
	await page.evaluate(() => {
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: async () => {
					throw new Error("clipboard denied");
				},
			},
		});
		window.open = () => null;
	});
	await page.getByRole("button", { name: "Copy code and open GitHub" }).click();
	await expect(page.getByText(
		`Failed to open browser. Please visit https://github.com/login/device and enter the code ${code} manually.`,
	)).toBeVisible();
	await page.evaluate(() => {
		window.open = () => ({ opener: null }) as Window;
	});
	await page.getByRole("button", { name: "Copy code and open GitHub" }).click();
	await expect(page.getByText(
		`Failed to copy to clipboard. Please visit https://github.com/login/device and enter the code ${code} manually.`,
	)).toBeVisible();
	await expect(page.getByText("Waiting for authorization...")).toBeVisible();
	await page.goto("about:blank");
	await writeFile(join(directory, "approval"), code);
	await page.waitForTimeout(1_500);
	await page.goto(ORIGIN);
	await expect(page.getByRole("button", { name: "octocat", exact: true }))
		.toBeVisible({ timeout: 20_000 });
	let session = await page.request.get(`${ORIGIN}/api/session`);
	expect((await session.json()).user.login).toBe("octocat");
	expect(await (await outsider.request.get(`${ORIGIN}/api/session`)).json())
		.toMatchObject({ user: null });
	await outsider.close();
	let mcp = await page.request.get(`${ORIGIN}/mcp`);
	expect(mcp.status()).toBe(401);
	expect(
		(await page.context().cookies()).filter(value => value.name.startsWith("chopin_"))
			.every(value => value.httpOnly),
	).toBe(true);
	expect(
		await page.evaluate(() =>
			[...Object.values(localStorage), ...Object.values(sessionStorage)]
				.some(value => /gh[ur]_[A-Za-z0-9_-]+/.test(value))
		),
	).toBe(false);
	expect((await readdir(directory)).sort()).toEqual(["approval", "fake-vault"]);
	expect(await readdir(join(directory, "fake-vault"))).toHaveLength(1);
	await stop(child);
	child = await server(directory);
	let navigationResponse = page.waitForResponse(`${ORIGIN}/api/navigation`);
	await page.reload();
	let navigation = await (await navigationResponse).json();
	await expect(page.getByRole("button", { name: "octocat", exact: true }))
		.toBeVisible({ timeout: 20_000 });
	await expect(page.getByText("Enter one-time code:")).toHaveCount(0);
	// An empty navigation opens Add project after the account controls have already mounted.
	// Other local-mode tests may have populated this fake account, so open it manually then.
	if (navigation.projects.length > 0) {
		await page.getByRole("complementary", { name: "Projects" })
			.getByRole("button", { name: "Add project", exact: true }).click();
	}
	await expect(page.getByRole("textbox", { name: "Search repositories" })).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("button", { name: "Close Add project" })).toHaveCount(0);
	await page.getByRole("button", { name: "octocat", exact: true }).click();
	await page.getByRole("menuitem", { name: "Sign out" }).click();
	await expect(page.getByText("Open your workspace")).toBeVisible();
	expect(await readdir(join(directory, "fake-vault"))).toHaveLength(0);
	await stop(child);
	child = await server(directory, true);
	await page.reload();
	await page.getByRole("button", { name: /sign in|device|github/i }).first().click();
	await expect(instruction).toBeVisible();
	let firstCode = (await instruction.textContent())!.match(/E2E-\d{4}/)![0]!;
	await writeFile(join(directory, "approval"), firstCode);
	await expect(page.getByRole("region", { name: "System vault not available" })).toBeVisible({
		timeout: 20_000,
	});
	await expect(page.getByText("System vault not available")).toBeVisible();
	await expect(page.getByText(join(directory, "config"), { exact: false })).toBeVisible();
	await expect(page.getByRole("checkbox")).toHaveCount(0);
	await page.getByRole("button", { name: "No, cancel sign-in" }).click();
	await expect(page.getByText("Open your workspace")).toBeVisible();
	expect((await readdir(directory)).sort()).toEqual(["approval", "fake-vault"]);
	await page.getByRole("button", { name: /sign in|device|github/i }).first().click();
	await expect(instruction).toBeVisible();
	let dismissedCode = (await instruction.textContent())!.match(/E2E-\d{4}/)![0]!;
	expect(dismissedCode).not.toBe(firstCode);
	await writeFile(join(directory, "approval"), dismissedCode);
	await expect(page.getByRole("region", { name: "System vault not available" })).toBeVisible({
		timeout: 20_000,
	});
	await page.keyboard.press("Escape");
	await expect(page.getByRole("region", { name: "System vault not available" })).toHaveCount(0);
	await expect(page.getByText("Open your workspace")).toBeVisible();
	expect((await readdir(directory)).sort()).toEqual(["approval", "fake-vault"]);
	await page.getByRole("button", { name: /sign in|device|github/i }).first().click();
	await expect(instruction).toBeVisible();
	let nextCode = (await instruction.textContent())!.match(/E2E-\d{4}/)![0]!;
	expect(nextCode).not.toBe(dismissedCode);
	await writeFile(join(directory, "approval"), nextCode);
	await expect(page.getByRole("region", { name: "System vault not available" })).toBeVisible({
		timeout: 20_000,
	});
	await page.getByRole("button", { name: "Yes, store in plain text (insecure)" }).click();
	await expect(page.getByRole("button", { name: "octocat", exact: true }))
		.toBeVisible({ timeout: 20_000 });
	let files = await readdir(join(directory, "config"));
	expect(files).toHaveLength(1);
	expect((await stat(join(directory, "config"))).mode & 0o777).toBe(0o700);
	expect((await stat(join(directory, "config", files[0]!))).mode & 0o777).toBe(0o600);
	await stop(child);
	child = await server(directory, true);
	navigationResponse = page.waitForResponse(`${ORIGIN}/api/navigation`);
	await page.reload();
	navigation = await (await navigationResponse).json();
	await expect(page.getByRole("button", { name: "octocat", exact: true }))
		.toBeVisible({ timeout: 20_000 });
	await expect(page.getByRole("region", { name: "System vault not available" })).toHaveCount(0);
	if (navigation.projects.length === 0) {
		await expect(page.getByRole("textbox", { name: "Search repositories" })).toBeFocused();
		await page.keyboard.press("Escape");
		await expect(page.getByRole("button", { name: "Close Add project" })).toHaveCount(0);
	}
	await page.getByRole("button", { name: "octocat", exact: true }).click();
	await page.getByRole("menuitem", { name: "Sign out" }).click();
	await expect(page.getByText("Open your workspace")).toBeVisible();
	expect(await readdir(join(directory, "config"))).toHaveLength(0);
});

test("local workspace Codex answers ordinary Chat, reads local source, edits, asks approvals and resumes per-document conversations", async ({ page }) => {
	test.setTimeout(90_000);
	let directory = await mkdtemp(join(tmpdir(), "chopin-codex-e2e-"));
	directories.push(directory);
	let checkout = join(directory, "checkout");
	await mkdir(join(checkout, ".git"), { recursive: true });
	await writeFile(join(checkout, "source.txt"), "Uncommitted local source for Codex.");
	let git = async (...args: string[]) => {
		let result = Bun.spawn([
			"git",
			"-C",
			checkout,
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.com",
			"-c",
			"core.hooksPath=/dev/null",
			...args,
		], { stdout: "pipe", stderr: "pipe" });
		if (await result.exited) throw new Error(await new Response(result.stderr).text());
	};
	await git("init");
	await git("add", "source.txt");
	await git("commit", "-m", "initial test source");

	let command = join(directory, "fake-codex.ts");
	await writeFile(
		command,
		`#!${process.execPath}\nimport ${
			JSON.stringify(join(ROOT, "e2e/harness/codex-process.ts"))
		};\n`,
	);
	await chmod(command, 0o700);
	let token = "local-workspace-codex-test-" + "a".repeat(43);
	let extra = {
		CHOPIN_MODE: "workspace",
		CHOPIN_WORKSPACE_AGENT: "codex",
		CHOPIN_CODEX_COMMAND: command,
		CHOPIN_CODEX_STATE_DIR: join(directory, "codex-state"),
		CHOPIN_WORKSPACE_DIR: directory,
		CHOPIN_LOCAL_AI: JSON.stringify({
			version: 1,
			revision: 1,
			connections: [{
				id: "codex",
				name: "Test Codex",
				transport: "codex",
				command: [command],
				mode: "launch",
				modelHosts: [],
				launchApproved: true,
				registeredAt: new Date().toISOString(),
				models: ["codex-test", "codex-alternative"].map(id => ({
					id,
					name: id,
					thinkingLevels: ["high"],
				})),
			}],
			roles: Object.fromEntries(
				["planner", "classifier", "prototyping"].map(
					role => [role, { connection: "codex", model: "codex-test", thinkingLevel: "high" }],
				),
			),
		}),
		CHOPIN_WORKSPACE_TOKEN: token,
		CHOPIN_WORKSPACES: JSON.stringify([{ name: "local/codex-test", path: checkout }]),
	};
	let child = await server(directory, false, extra);
	let create = async (title: string) => {
		let response = await page.request.post(ORIGIN + "/mcp", {
			headers: { authorization: `Bearer ${token}` },
			data: {
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "create_document",
					arguments: {
						repository: "local/codex-test",
						baseBranch: "main",
						baseCommit: "a".repeat(40),
						title,
						idempotencyKey: crypto.randomUUID(),
						plan: `# ${title}\n\nInitial document prose.\n`,
						brief: {
							goal: "Test local conversation",
							constraints: [],
							settledDecisions: [],
							openQuestions: [],
							repositoryFindings: [],
						},
					},
				},
			},
		});
		let payload = await response.json();
		expect(payload.result.isError).not.toBe(true);
		return payload.result.structuredContent as { id: string; url: string };
	};
	let first = await create("Codex first");
	let second = await create("Codex second");
	await page.goto(new URL(first.url, ORIGIN).href);
	await page.getByRole("textbox", { name: "Workspace access key" }).fill(token);
	await page.getByRole("button", { name: "Open workspace", exact: true }).click();
	let composer = page.getByRole("combobox", { name: "Message", exact: true });
	await expect(composer).toBeVisible();
	let send = async (text: string) => {
		await composer.fill(text);
		await composer.press("Enter");
	};
	await send("Read my local source");
	let reply = page.locator("[data-chat-scroll]").getByText(/Conversation .*Source:/);
	await expect(reply).toContainText("Uncommitted local source for Codex.");
	let identity = /Conversation ([^;]+)/.exec(await reply.innerText())![1]!;
	await page.getByRole("button", { name: /^Model: / }).click();
	await page.getByRole("option", { name: /^codex-alternative/ }).click();
	await send("Use my selected model");
	await expect(page.locator("[data-chat-scroll]").getByText(/model codex-alternative/))
		.toContainText(
			identity,
		);
	await send("Update the document");
	await expect(page.locator("[contenteditable=true]").first()).toContainText(
		"Updated through the dedicated Codex conversation.",
	);
	await send("Ask for approval");
	await expect(page.getByText("Run this sandboxed command?", { exact: false }).first())
		.toBeVisible();
	await page.getByRole("radio", { name: "Yes", exact: true }).first().click();
	await page.getByRole("button", { name: "Save", exact: true }).first().click();
	await expect(page.locator("[data-chat-scroll]")).toContainText("Command approved in Chopin.");

	await send("build and run");
	await expect(page.locator("[data-chat-scroll]")).toContainText(
		"Alternative A is ready in its copy.",
	);
	expect(await readFile(join(checkout, "source.txt"), "utf8")).toBe(
		"Uncommitted local source for Codex.",
	);
	await send("Apply alternative");
	await expect(
		page.getByText("Apply this prototype to the original checkout?", { exact: false }).first(),
	).toBeVisible();
	await page.getByRole("radio", { name: "Yes", exact: true }).first().click();
	await page.getByRole("button", { name: "Save", exact: true }).first().click();
	await expect(page.locator("[data-chat-scroll]")).toContainText("Selected changes applied.");
	expect(await readFile(join(checkout, "source.txt"), "utf8")).toBe("Selected prototype source.\n");
	await send("Verify my commit");
	await expect(page.locator("[data-chat-scroll]")).toContainText("Commit is still required.");
	await git("add", "source.txt");
	await git("commit", "-m", "human selected checkpoint");
	await send("Verify my commit");
	await expect(page.locator("[data-chat-scroll]")).toContainText("Manual commit verified.");
	await page.goto(new URL(second.url, ORIGIN).href);
	await expect(composer).toBeVisible();
	await send("Read the second document's source");
	await expect(reply).toContainText("Selected prototype source.");
	expect(await reply.innerText()).not.toContain(identity);
	await stop(child);
	child = await server(directory, false, extra);
	await page.goto(new URL(first.url, ORIGIN).href);
	await expect(composer).toBeVisible();
	await send("Continue after restart");
	await expect(
		page.locator("[data-chat-scroll]").getByText(
			new RegExp(`Conversation ${identity}; model codex-alternative`),
		),
	).toHaveCount(2);
	await send("Wait for Stop");
	await page.getByRole("button", { name: "Stop Chopin", exact: true }).click();
	await expect(page.getByRole("button", { name: "Stop Chopin", exact: true })).toHaveCount(0);
	await page.goto(ORIGIN + "/settings/ai");
	await expect(page.getByRole("heading", { name: "Local AI settings" })).toBeVisible();
	await page.getByRole("button", { name: "Add custom agent" }).click();
	await page.getByLabel("Connection name").fill("Test connection");
	await page.getByRole("combobox", { name: /^Transport/ }).selectOption("codex");
	await page.getByLabel("Executable and arguments (one per line)").fill(command);
	await page.getByRole("button", { name: "Save for next launch" }).click();
	await expect(page.getByRole("status")).toContainText("Saved");
	await expect(page.getByRole("checkbox")).toBeDisabled();
	let initialized = await page.request.post(ORIGIN + "/mcp", {
		headers: { authorization: `Bearer ${token}` },
		data: {
			jsonrpc: "2.0",
			id: 30,
			method: "initialize",
			params: {
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "test-ai", version: "1" },
			},
		},
	});
	let mcpSession = initialized.headers()["mcp-session-id"]!;
	let handshake = await page.request.post(ORIGIN + "/mcp", {
		headers: { authorization: `Bearer ${token}`, "mcp-session-id": mcpSession },
		data: {
			jsonrpc: "2.0",
			id: 31,
			method: "tools/call",
			params: { name: "confirm_workspace_ai_connection", arguments: { connection: "custom" } },
		},
	});
	expect((await handshake.json()).result.isError).not.toBe(true);
	await page.getByRole("button", { name: "Reload saved settings" }).click();
	await expect(page.getByText("MCP registration confirmed", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Probe reported models (starts agent)" }).click();
	await expect(page.getByRole("status")).toContainText("Reported models loaded");
	for (let role of ["Planner AI", "Classifier AI", "Prototyping AI"]) {
		let field = page.getByRole("group", { name: role, exact: true });
		await field.getByLabel("Connection and model").selectOption("custom:codex-test");
		await field.getByLabel("Thinking level").selectOption("high");
	}
	await page.getByRole("combobox", { name: /^Start connection/ }).selectOption("launch");
	await page.getByRole("checkbox").check();
	await page.getByRole("button", { name: "Save for next launch" }).click();
	await expect(page.getByRole("status")).toContainText("Saved");
	let saved = await (await page.request.get(ORIGIN + "/api/workspace/ai")).json();
	expect(saved.pending.roles.classifier.thinkingLevel).toBe("high");
	expect(saved.pending.connections[0].launchApproved).toBe(true);
	expect(saved.active.roles.planner.connection).toBe("codex");
	await stop(child);
	saved.pending.connections[0].mode = "attach";
	await writeFile(
		join(directory, "settings.json"),
		JSON.stringify({
			version: 1,
			token,
			port: e2ePort(8791),
			databaseUrl: process.env.E2E_DATABASE_URL_3!,
			repositories: [{ name: "local/codex-test", path: checkout }],
		}),
	);
	child = await server(directory, false, {
		...extra,
		CHOPIN_LOCAL_AI: JSON.stringify(saved.pending),
	});
	let bridge = spawn(process.execPath, ["scripts/workspace-agent.ts", "custom"], {
		cwd: ROOT,
		detached: true,
		env: { ...process.env, CHOPIN_WORKSPACE_DIR: directory },
		stdio: ["ignore", "ignore", "pipe"],
	});
	processes.push(bridge);
	await page.goto(new URL(second.url, ORIGIN).href);
	await expect(composer).toBeVisible();
	let manualReplies = page.locator("[data-chat-scroll]").getByText(/Source:/);
	let priorReplies = await manualReplies.count();
	await send("Read through my manually attached connection");
	await expect(manualReplies).toHaveCount(priorReplies + 1);
	await expect(page.locator("[data-chat-scroll]").getByText(/Source:/).last()).toContainText(
		"Selected prototype source.",
	);
	await stop(bridge);
	await stop(child);
});
