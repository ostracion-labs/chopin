import { WorkspaceAi } from "./workspace-ai";
import { useState } from "react";

import { LocalLoginShell } from "./local-login-shell";

export function WorkspaceLogin({ settings = false }: { settings?: boolean }) {
	return settings ? <WorkspaceAi /> : <WorkspaceSignIn />;
}

function WorkspaceSignIn() {
	let [token, setToken] = useState("");
	let [busy, setBusy] = useState(false);
	let [error, setError] = useState("");
	return (
		<LocalLoginShell title="Open your local workspace">
			<form
				className="mt-4 flex flex-col gap-3"
				onSubmit={async event => {
					event.preventDefault();
					if (busy) return;
					setBusy(true);
					setError("");
					try {
						let response = await fetch("/auth/workspace", {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ token }),
						});
						if (!response.ok) {
							throw new Error("Could not open the workspace. Check your access key.");
						}
						location.reload();
					} catch (reason) {
						setError(reason instanceof Error ? reason.message : "Could not open the workspace.");
						setBusy(false);
					}
				}}
			>
				<label className="text-sm text-text-secondary" htmlFor="workspace-key">
					Workspace access key
				</label>
				<input
					autoComplete="current-password"
					className="field w-full px-3 py-2 text-sm"
					id="workspace-key"
					onChange={event => setToken(event.target.value)}
					required
					type="password"
					value={token}
				/>
				{error && <p className="text-sm text-destructive-ink" role="alert">{error}</p>}
				<button className="btn btn-md btn-primary w-full" disabled={busy} type="submit">
					{busy ? "Opening workspace" : "Open workspace"}
				</button>
			</form>
		</LocalLoginShell>
	);
}
