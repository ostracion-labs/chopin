# Local workspaces without GitHub

Workspace mode runs Chopin's document UI, collaboration server, MCP tools and
PostgreSQL on your computer. Register an existing checkout with a local alias;
its remote can be GitLab, another host, or absent. This first version has one local
owner. It does not provide a GitLab API or shared-team authentication.

Chat inside Chopin uses a persistent AI conversation per root document; children
use the root's Chat. Planner, Classifier and Prototyping roles have separate
connection, model and thinking settings. Codex reuses its existing ChatGPT login.
ACP adapters can connect Claude and other providers supported by the installed
agent, including Chinese model providers configured in OpenCode. Model inference
may be remote: local workspace mode describes the UI, source and execution location.
Only source material the chosen agent reads is available to its model.

The classifier checks whether an AI reply requests human input, so the existing
repair pipeline creates Decision cards. It does not classify shell commands for
safety. Command approvals and filesystem/network restrictions are separate.
Hosted research, summaries, builds and automatic jobs remain disabled. GitHub mode
remains available when `CHOPIN_MODE` is unset.

## Start locally

Install Bun 1.4.4 and Docker Compose, then from the Chopin checkout:

```sh
bun install --frozen-lockfile
bun run workspace init local/my-project /absolute/path/to/my-project
bun run workspace db up
bun run workspace prepare
bun run workspace start
```

Open [Chopin](http://127.0.0.1:8787). Get your private workspace access key with:

```sh
bun run workspace key
```

Paste it into the sign-in form. Add the registered project from **Add project**,
then create a document. The access key also authenticates MCP clients: do not put
it in a document, chat, Git commit or shared configuration.

Settings, the access key and database URL live in
`$XDG_STATE_HOME/chopin/workspace/settings.json` (by default
`~/.local/state/chopin/workspace/settings.json`). The directory is created with
mode 0700 and the file with mode 0600. Set `CHOPIN_WORKSPACE_DIR` on every command
to use another directory. Set `DATABASE_URL` before `init` to use an existing
PostgreSQL database. The default uses the isolated workspace Compose database on
loopback port 55432, separate from Chopin's ordinary development database and the
usual PostgreSQL port 5432. `bun run workspace db down` stops it without removing
its data volume.

You can edit `port` in that private settings file before preparing or starting
the app. The origin and bind remain loopback. To register another checkout:

```sh
bun run workspace add local/another-project /absolute/path/to/another-project
```

Restart Chopin after changing registrations. Names are local aliases, not GitLab
namespaces, so a GitLab subgroup path does not need to fit the alias. A checkout's
canonical filesystem path supplies its identity. Moving it to another path makes
it a different repository; changing only its alias does not migrate existing
document URLs. Keep an existing registration stable once it has documents.

## Configure Chat and AI roles

Open **AI settings** from the account menu, or visit
[AI settings](http://127.0.0.1:8787/settings/ai).

1. Add an installed agent or a custom absolute executable and arguments. Discovery
   only checks executable paths; it never installs or starts agents.
2. Save the connection. Add Chopin's `/mcp` endpoint to that agent using the local
   workspace access key (the Codex example is below).
3. In that agent, call `describe_workspace_ai`, then
   `confirm_workspace_ai_connection` with its saved connection ID. This confirms
   MCP registration only; an AI cannot approve its own launch.
4. Reload settings. Press **Probe reported models** to start a capability probe.
   Choose Planner, Classifier and Prototyping models and thinking levels. Use Luna
   for classification and Sol for prototyping where your runtime offers them.
   Astra is excluded from prototyping. No fallback model is selected silently.
5. Choose manual attachment or explicitly approve on-demand launch. Save, then
   restart Chopin. All three roles must be ready before startup activates Chat.

```sh
bun run workspace service restart
# Or stop and restart bun run workspace start in the foreground.
```

Settings live in private `ai.json` beside `settings.json`. Edits are pending until
restart. Changing an executable, transport or model-service host list invalidates
its MCP registration. Model catalogs and registration timestamps are server-owned.
To disable local agent execution, run `bun run workspace agent off` and restart;
`bun run workspace agent codex` re-enables configured roles, despite its legacy name.

Codex must already be signed in (`codex login`). The runtime's advertised models
can differ from those offered by the desktop app or your account; unsupported
models fail visibly. This does not attach to this desktop chat: Chopin owns
separate conversations using the same account and selected supported model.
Neither the desktop app nor its current conversation needs to remain open.

### Manual attachment and other providers

For a connection saved as manual, start its bridge from this source checkout:

```sh
bun scripts/workspace-agent.ts CONNECTION_ID
```

Keep that terminal open. The bridge uses the private local workspace settings;
no key is put on its command line. A lost connection ends the active turn without
replaying tool writes. Reconnect and send a new message to continue.

ACP agents must support HTTP MCP, report a model catalog, and support session
loading to resume after restart. Unsupported thinking levels are refused. Claude
needs a compatible ACP adapter, such as `claude-agent-acp`; a native `claude`
executable alone is not an ACP connection. OpenCode uses `opencode acp` and its
existing provider login. See [OpenCode ACP](https://opencode.ai/docs/cli/acp) and
[Claude ACP](https://zed.dev/acp/agent/claude-agent).

ACP processes always use the connector Sandbox seam with a required sandbox.
They can reach only the configured model-service hosts and their document-scoped
loopback tool bridge. The usual connector's GitHub/package host list is replaced.
On Linux, follow the sandbox's reported dependency instructions. ACP's proxy-enabled
sandbox needs `slirp4netns`; offline MCP confinement does not. A missing sandbox refuses ACP launch. Codex uses
its own enforced read-only/copy-write tool sandbox with networking disabled.

### Configured MCP tools

Codex conversations load enabled local stdio MCP servers from the effective Codex
configuration for the registered checkout, including codebase-memory and execution
tools such as `node_repl`. Existing document conversations resume with these tools;
there is no need to reset their history. Classifier workers have no MCP tools.

Each local MCP server starts through the connector's required process sandbox with
offline networking. It reads registered source trees, its configured executable,
explicit language/module paths and system tools. Writes are limited to private MCP
state, temporary storage, and the active prototype copy. Host browser/executor
environment variables are removed. Host home and runtime socket directories are
not inherited; a socket in an explicitly exposed user tree refuses that server's
launch. There is no unconfined fallback. A server requiring other host paths or
network services may therefore be unavailable.

Unknown, write, execute and destructive tools require native Codex approval,
presented through Chopin Decisions. Read-only annotations are approval hints, not
filesystem authority: even an incorrectly annotated tool cannot write original
source. MCP forms also use Decisions; URL authentication requests are declined.
Push tools are excluded, networking is blocked, and repositories outside the
prototype are read-only even if a generic execution tool overrides Git settings.

Codebase-memory keeps its index/cache privately per document and server. An
existing index from a separate Codex chat is not reused. Approve `index_repository`
when needed, passing the original registered source path explicitly; subsequent
graph queries use that private index. Use `persistence: false` to keep artifacts
outside the read-only source. Its private local daemon socket is supported.
MCP processes restart between turns, resetting JavaScript globals; saved indexes
remain available to the document.

Remote HTTP MCP servers cannot be confined by a local process sandbox and remain
unavailable in this mode. Chopin supplies its own current-document host tools instead
of inheriting the broadly authorized HTTP Chopin MCP connection. ACP agents retain
their own configured MCP tools inside the existing whole-agent sandbox; this Codex
configuration import does not discover another provider's private configuration.

### Prototype and manual-commit checkpoints

`prototype_local` starts the configured Prototyping AI in an independent copy,
including uncommitted source. Copies omit `.git`, symlinks, credentials and common
generated/dependency directories. Tests needing omitted dependencies may require
additional preparation; the worker must report that limitation. Each experiment
has a bounded copy (256 MiB total, 8 MiB per file), a 20-minute deadline and a
separate conversation. The classifier is a fresh structured worker with no
Chopin document tools; malformed or missing verdicts withhold the reply.

Alternatives stay in their copies. `apply_local_checkpoint` presents a Decision
for a human's sub-final selection and suggested commit message. Only Yes applies
the immutable sealed candidate to original files, after checking their baseline
hashes. Existing edits that changed since the copy cause refusal. Local writes
are allowed here; agents themselves never receive write access to originals.

Chopin then waits for a human to commit manually. `verify_local_commit` reads
HEAD and committed file objects to prove the selected files are in a new commit.
An unrelated or empty commit does not pass. No next checkpoint starts until the
commit is verified. Pushing remains the human's independent choice.

The original is never staged, committed, fetched or pushed by this workflow.
Codex apps, plugins, hooks and browser integrations are disabled. Configured local
MCP services run only inside the confinement described above. Approvals cannot lift its
filesystem/network policy. GitHub machine/build endpoints remain unavailable.
An independently running agent or terminal keeps its own permissions.

Checkpoint state, immutable baseline/candidate files and thread mappings are kept
privately under the workspace state directory. Keep them with the agent's own
conversation state when backing up. A stopped worker leaves its copy for review.
If a host write fails halfway, the checkpoint is marked `conflict` (a crash can
leave `applying`) and blocks later checkpoints: inspect the preserved baseline,
candidate and original before resolving it. After manually finishing all selected
files or restoring them all from the baseline, `verify_local_commit` reconciles
the interrupted status without rewriting source. A fully applied selection still
requires its manual commit; a fully restored selection returns to prototype state. Multi-file writes are not an atomic
filesystem transaction. Concurrent human edits are checked before application,
but an external editor racing the actual writes remains a limitation.

## Use Codex's own chat through MCP

Print the MCP configuration fragment:

```sh
bun run workspace codex-config
```

Add that fragment to your user-level `~/.codex/config.toml` (not the repository's
shared configuration). Before starting Codex, export the access key in the same
environment:

```sh
export CHOPIN_WORKSPACE_TOKEN="$(bun run --silent workspace key)"
codex /absolute/path/to/my-project
```

For a desktop app, supply the environment variable to the app process before
restarting it. An export in an unrelated terminal does not change an already
running app's environment. Keep your existing model selection and authentication;
Chopin supplies tools, not another model.

Ask the agent:

```text
Use Chopin's list_documents tool for local/my-project. Read the selected document,
inspect this local checkout, and update the document with our agreed changes.
Ask me before pushing code.
```

The emitted MCP configuration asks for tool approval by default. For the familiar
workspace-editing permission boundary, Codex's project-local defaults can be:

```toml
approval_policy = "on-request"
approvals_reviewer = "user"
sandbox_mode = "workspace-write"

[sandbox_workspace_write]
network_access = false
```

This lets Codex work inside its workspace and asks you about operations beyond
the sandbox. It does not ask before every local edit, and it is not a no-push
guarantee for Codex. Existing user, managed and session settings can override
project defaults. Restart the app/chat as appropriate and check its permissions
control. See [Codex permissions](https://learn.chatgpt.com/docs/permission-modes).

## Keep Chopin running on Linux

After `prepare`, install the app's systemd user service:

```sh
bun run workspace service install
bun run workspace service status
```

The service runs this checkout's local server. With configured roles enabled, it starts approved local runtimes on demand; it
never starts the GitHub coding-agent connector.
It starts at login, restarts after failure, and
requires this checkout, its dependencies and Bun to remain available. Rebuild
with `prepare` after updating source. PostgreSQL must also be running. The workspace
Compose database restarts with Docker; the Docker service must start at boot too.

For the user service to start at boot and survive logout, enable lingering for
your account (your system may ask for administrator approval):

```sh
loginctl enable-linger "$USER"
```

Logs and service controls:

```sh
journalctl --user -u chopin-workspace.service -f
bun run workspace service stop
bun run workspace service start
bun run workspace service uninstall
```

Removing the service keeps settings and documents. Background installation on
macOS and Windows is not included in this first version; foreground startup is
available wherever Bun and PostgreSQL run.

## Use it from outside

Keep the server bound to loopback. From another computer that already has SSH
access to yours, forward the same port:

```sh
ssh -N -L 8787:127.0.0.1:8787 your-user@your-computer
```

Open `http://127.0.0.1:8787` on that computer and use your workspace access key.
If you changed the configured port, change it in all three positions. Your home
computer must be awake, and SSH must already be reachable. The launcher does not
configure a router, VPN, public hostname or remote desktop access. No cloud
deployment is needed.

## Implementation boundary

`apps/server/src/workspace/` contains the local authority and registration
validation. A compatibility adapter feeds existing session, repository and
document DTOs; its legacy `permissions.push` field means permission to edit a
Chopin document, not permission to push Git. Local repository IDs are namespaced
`workspace:` IDs. This adapter exposes no Git or provider API operations.

The HTTP boundary allows local document, catalogue, navigation, session and AI
configuration/attachment routes. Hosted connector and execution routes are refused
before dispatch. MCP advertises local setup tools alongside document tools; it
omits hosted Planner invocation and implementation operations. The local Planner's
host tools own Decision-gated checkpoint writes and Git reads. This guarantee covers
work Chopin starts; independent agents and terminals retain their own permissions.
