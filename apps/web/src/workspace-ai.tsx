import { useEffect, useState } from "react";
import type { AiConnection, AiRole, LocalAiConfiguration } from "@chopin/protocol/local-ai";

type Discovery = {
	id: string;
	name: string;
	transport: "codex" | "acp";
	command: string[];
	hosts: string[];
	installed: boolean;
	needsAdapter: boolean;
};
type State = {
	pending: LocalAiConfiguration;
	active: LocalAiConfiguration;
	discovered: Discovery[];
};
const roles: AiRole[] = ["planner", "classifier", "prototyping"];
const labels = {
	planner: "Planner AI",
	classifier: "Classifier AI",
	prototyping: "Prototyping AI",
};

async function api(path = "", body?: unknown, method = "POST") {
	let response = await fetch(
		`/api/workspace/ai${path}`,
		body
			? { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
			: undefined,
	);
	let result = await response.json();
	if (!response.ok) throw new Error(result.error ?? "AI settings could not be loaded");
	return result;
}

export function WorkspaceAi() {
	let [state, setState] = useState<State>();
	let [error, setError] = useState("");
	let [notice, setNotice] = useState("");
	let [busy, setBusy] = useState(false);
	const reload = async () => setState(await api());
	useEffect(() => {
		void reload().catch(reason => setError(reason.message));
	}, []);
	const action = async (work: () => Promise<void>) => {
		setBusy(true);
		setError("");
		setNotice("");
		try {
			await work();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "AI settings failed");
		} finally {
			setBusy(false);
		}
	};
	const update = (change: (config: LocalAiConfiguration) => void) =>
		setState(current => {
			if (!current) return current;
			let next = structuredClone(current);
			change(next.pending);
			return next;
		});
	const connectionChange = (id: string, change: (item: AiConnection) => void) =>
		update(config => {
			let item = config.connections.find(item => item.id === id);
			if (item) change(item);
		});
	const add = (item?: Discovery) =>
		update(config => {
			let base = item?.id ?? "custom";
			let id = base;
			let suffix = 1;
			while (config.connections.some(connection => connection.id === id)) {
				id = `${base}-${++suffix}`;
			}
			config.connections.push({
				id,
				name: item?.name ?? "Custom ACP agent",
				transport: item?.transport ?? "acp",
				command: item?.command ?? ["/absolute/path/to/agent"],
				modelHosts: item?.hosts ?? [],
				models: [],
				mode: "attach",
				launchApproved: false,
			});
		});
	return (
		<main className="h-dvh overflow-y-auto bg-ground px-6 py-8 text-sm text-text-primary">
			<div className="mx-auto flex max-w-3xl flex-col gap-6">
				<a className="btn btn-md btn-ghost self-start" href="/">Back to documents</a>
				<header>
					<h1 className="font-document-heading text-2xl">Local AI settings</h1>
					<p className="mt-2 text-text-secondary">
						Choose a connection, model and thinking level for each role. Your agent keeps its own
						login. Saved defaults activate on the next Chopin launch.
					</p>
				</header>
				{error && <p className="text-destructive-ink" role="alert">{error}</p>}
				{notice && <p role="status">{notice}</p>}
				{!state ? <p>Loading connections</p> : (
					<>
						<section className="flex flex-col gap-3" aria-labelledby="installed-heading">
							<h2 className="font-document-heading text-xl" id="installed-heading">
								Installed agents
							</h2>
							<p className="text-text-secondary">
								Discovery checks executable paths only. Nothing is installed or launched by this
								scan.
							</p>
							<div className="flex flex-wrap gap-2">
								{state.discovered.map(item => (
									<button
										className="btn btn-md btn-secondary"
										disabled={!item.installed || busy}
										key={item.id}
										onClick={() => add(item)}
										type="button"
									>
										Add {item.name}
										{!item.installed
											? item.needsAdapter ? " (adapter needed)" : " (not found)"
											: ""}
									</button>
								))}
								<button className="btn btn-md btn-secondary" onClick={() => add()} type="button">
									Add custom agent
								</button>
							</div>
						</section>
						{state.pending.connections.map(connection => (
							<fieldset
								className="flex min-w-0 flex-col gap-3 rounded-lg bg-page p-4"
								key={connection.id}
							>
								<legend className="font-medium">{connection.name}</legend>
								<label className="flex flex-col gap-1">
									Connection name<input
										className="field px-3 py-2"
										value={connection.name}
										onChange={event =>
											connectionChange(connection.id, item => {
												item.name = event.target.value;
											})}
									/>
								</label>
								<p className="text-text-secondary">
									Connection ID: <code>{connection.id}</code>
								</p>
								<label className="flex flex-col gap-1">
									Transport<select
										className="field px-3 py-2"
										value={connection.transport}
										onChange={event =>
											connectionChange(connection.id, item => {
												item.transport = event.target.value as "codex" | "acp";
												item.launchApproved = false;
											})}
									>
										<option value="codex">Codex app server (ChatGPT login)</option>
										<option value="acp">Agent Client Protocol</option>
									</select>
								</label>
								<label className="flex flex-col gap-1">
									Executable and arguments (one per line)<textarea
										className="field px-3 py-2 font-mono"
										rows={3}
										value={connection.command.join("\n")}
										onChange={event =>
											connectionChange(connection.id, item => {
												item.command = event.target.value.split("\n");
												item.launchApproved = false;
											})}
									/>
								</label>
								{connection.transport === "acp" && (
									<label className="flex flex-col gap-1">
										Allowed model service hosts (one per line)<textarea
											className="field px-3 py-2 font-mono"
											rows={3}
											value={connection.modelHosts.join("\n")}
											onChange={event =>
												connectionChange(connection.id, item => {
													item.modelHosts = event.target.value.split("\n").filter(Boolean);
													item.launchApproved = false;
												})}
										/>
										<span className="text-text-secondary">
											Use your model provider's hosts. Git hosts are not needed. ACP requires a
											working process sandbox and HTTP MCP support.
										</span>
									</label>
								)}
								<label className="flex flex-col gap-1">
									Start connection<select
										className="field px-3 py-2"
										value={connection.mode}
										onChange={event =>
											connectionChange(connection.id, item => {
												item.mode = event.target.value as "attach" | "launch";
											})}
									>
										<option value="attach">I attach it manually</option>
										<option value="launch">Chopin launches it when needed</option>
									</select>
								</label>
								<p>
									{connection.registeredAt
										? "MCP registration confirmed"
										: "MCP registration needed"}
								</p>
								<p className="text-text-secondary">
									Save this connection, then add <code>{location.origin}/mcp</code>{" "}
									to the agent's MCP configuration using your workspace access key. Ask that agent
									to call <code>confirm_workspace_ai_connection</code> with{" "}
									<code>{`{"connection":"${connection.id}"}`}</code>. Reload after registration.
								</p>
								{connection.mode === "attach" && (
									<p className="overflow-x-auto text-text-secondary">
										Start from this checkout:{" "}
										<code>bun scripts/workspace-agent.ts {connection.id}</code>
									</p>
								)}
								<label className="flex items-start gap-2">
									<input
										checked={connection.launchApproved}
										disabled={!connection.registeredAt || connection.mode !== "launch"}
										onChange={event =>
											connectionChange(connection.id, item => {
												item.launchApproved = event.target.checked;
											})}
										type="checkbox"
									/>I allow Chopin to launch this exact agent after restart.
								</label>
								<button
									className="btn btn-md btn-secondary self-start"
									disabled={busy || !connection.registeredAt}
									onClick={() =>
										void action(async () => {
											await api(`/${connection.id}/probe`, {});
											await reload();
											setNotice("Reported models loaded. Choose role defaults below.");
										})}
									type="button"
								>
									Probe reported models (starts agent)
								</button>
								<button
									className="btn btn-md btn-ghost self-start"
									onClick={() =>
										update(config => {
											config.connections = config.connections.filter(item =>
												item.id !== connection.id
											);
											for (let role of roles) {
												if (config.roles[role]?.connection === connection.id) {
													delete config.roles[role];
												}
											}
										})}
									type="button"
								>
									Remove connection
								</button>
							</fieldset>
						))}
						<section className="flex flex-col gap-4" aria-labelledby="roles-heading">
							<h2 className="font-document-heading text-xl" id="roles-heading">Role defaults</h2>
							<p className="text-text-secondary">
								Classifier checks whether a reply asks for human input so it becomes a Decision.
								Luna is the intended economical choice. Prototyping implements and tests copies;
								choose Sol. Models are never substituted automatically.
							</p>
							{roles.map(role => {
								let selected = state.pending.roles[role];
								let connection = state.pending.connections.find(item =>
									item.id === selected?.connection
								);
								let model = connection?.models.find(item => item.id === selected?.model);
								return (
									<fieldset className="flex flex-col gap-2 rounded-lg bg-page p-4" key={role}>
										<legend className="font-medium">{labels[role]}</legend>
										<label className="flex flex-col gap-1">
											Connection and model<select
												className="field px-3 py-2"
												value={selected ? `${selected.connection}:${selected.model}` : ""}
												onChange={event =>
													update(config => {
														let value = event.target.value;
														let colon = value.indexOf(":");
														if (colon < 0) delete config.roles[role];
														else {config.roles[role] = {
																connection: value.slice(0, colon),
																model: value.slice(colon + 1),
															};}
													})}
											>
												<option value="">Select a reported model</option>
												{state.pending.connections.filter(item => !!item.registeredAt).map(item => (
													<optgroup key={item.id} label={item.name}>
														{item.models.filter(model =>
															role !== "prototyping" || !/astra/i.test(model.id)
														).map(model => (
															<option key={model.id} value={`${item.id}:${model.id}`}>
																{model.name}
															</option>
														))}
													</optgroup>
												))}
											</select>
										</label>
										<label className="flex flex-col gap-1">
											Thinking level<select
												className="field px-3 py-2"
												disabled={!selected}
												value={selected?.thinkingLevel ?? ""}
												onChange={event =>
													update(config => {
														if (config.roles[role]) {
															config.roles[role]!.thinkingLevel = event.target.value || undefined;
														}
													})}
											>
												<option value="">Agent default</option>
												{model?.thinkingLevels?.map(level => (
													<option key={level} value={level}>{level}</option>
												))}
											</select>
										</label>
									</fieldset>
								);
							})}
						</section>
						<p className="text-text-secondary">
							Prototypes remain in copies until you approve a checkpoint. Applying checks for
							conflicting edits. You commit manually before the next checkpoint; Chopin never
							commits or pushes your checkout.
						</p>
						<div className="flex gap-2">
							<button
								className="btn btn-md btn-primary"
								disabled={busy}
								onClick={() =>
									void action(async () => {
										let result = await api("", state.pending, "PUT");
										setState({ ...state, pending: result.pending });
										setNotice(
											"Saved. Restart Chopin after all three roles and launch permissions are ready.",
										);
									})}
								type="button"
							>
								Save for next launch
							</button>
							<button
								className="btn btn-md btn-secondary"
								disabled={busy}
								onClick={() => void action(reload)}
								type="button"
							>
								Reload saved settings
							</button>
						</div>
						<p className="text-text-secondary">
							Active roles:{" "}
							{roles.map(role => `${labels[role]}: ${state.active.roles[role]?.model ?? "off"}`)
								.join("; ")}
						</p>
					</>
				)}
			</div>
		</main>
	);
}
