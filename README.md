# Chopin

Chopin is an experimental workspace for authoring repository-connected documents
with AI agents. Use it for implementation plans, technical specifications, RFCs,
proposals, and decision records. Chat, rich-text documents, comments, and human
Decisions stay together while you refine the work.

This checkout includes a **local workspace mode** for existing repositories,
including GitLab checkouts and repositories without a remote, alongside the
original **GitHub-connected mode** for team collaboration.

Chopin originated as a GitHub Next research prototype. See the
[original project](https://githubnext.com/projects/chopin/) for its research goals.

> [!IMPORTANT]
> Chopin is experimental software, not a supported GitHub product or a
> production-ready service. Expect incomplete workflows and breaking changes.

## Current status

The app runs as a Bun server with a browser UI and PostgreSQL storage. Local
workspace mode is available from a source checkout; the downloadable `chopin`
CLI connects a machine to an existing GitHub-connected server and does not install
this local app.

| Capability                         | Local workspace mode                                                             | GitHub-connected mode                                                             |
| ---------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Repository source                  | Registered local checkouts, including uncommitted files                          | GitHub.com repositories authorized for the instance                               |
| Sign-in                            | Private workspace access key; one local owner                                    | GitHub sign-in and repository access checks                                       |
| Documents and Decisions            | Local document editing, comments, questions, and approvals                       | Shared team documents, comments, and Decisions                                    |
| AI conversation                    | Persistent conversation per root document through configured Codex or ACP agents | Planner through Copilot SDK, Atomic, or an attached remote agent                  |
| Prototyping                        | Independent copies, human-approved application, manual commits                   | Machine-based investigations and build workflows                                  |
| Hosted research and automatic jobs | Disabled                                                                         | Available according to server configuration                                       |
| Background startup                 | Linux systemd user service                                                       | Operator-managed deployment; connector services support Linux, macOS, and Windows |

Local workspace mode keeps the UI, source access, and agent processes on your
computer. **Model inference may still use a remote provider** through the agent's
existing login or provider configuration. It is not an offline model bundle.

## Run a local workspace

Install **Bun 1.4.4** and **Docker with Docker Compose**, then clone or download
this repository and open a terminal in its root. No GitHub App is required.

First-time setup:

```bash
bun install --frozen-lockfile
bun run workspace init local/my-project /absolute/path/to/my-project
bun run workspace db up
bun run workspace prepare
bun run workspace key
bun run workspace start
```

Replace `/absolute/path/to/my-project` with an existing Git checkout you want to
work with. `local/my-project` is its local alias; it does not have to match a
GitHub or GitLab namespace. `prepare` builds the browser client and applies database
migrations.

Open [http://127.0.0.1:8787](http://127.0.0.1:8787), sign in with the key printed by
`workspace key`, add the registered checkout through **Add project**, and create a
document. The app starts with AI off until its connections and roles are configured.

For later foreground runs:

```bash
bun run workspace db up
bun run workspace start
```

Ctrl-C stops the foreground app. `bun run workspace db down` stops its database
without deleting the data volume. After updating source, install dependencies,
run `bun run workspace prepare` with the database running, and restart the app.

Register another checkout with:

```bash
bun run workspace add local/another-project /absolute/path/to/another-project
```

Restart Chopin after changing registrations. The app binds to loopback on port
8787; its separate workspace database binds to loopback on port 55432.

### Configure AI

Install and sign in to your chosen agent first. In Chopin, open **AI settings**
from the account menu or visit
[http://127.0.0.1:8787/settings/ai](http://127.0.0.1:8787/settings/ai).

1. Add an agent connection. Codex uses its existing ChatGPT login. ACP connections
   can use compatible adapters such as `claude-agent-acp` or `opencode acp`.
2. Register Chopin's MCP endpoint in that agent, then have the agent call
   `describe_workspace_ai` and `confirm_workspace_ai_connection` for the saved
   connection. Registration confirms the connection; it does not approve launch.
3. Probe the connection's reported models, then configure **Planner**,
   **Classifier**, and **Prototyping** models and thinking levels. All three roles
   must be ready before Chat activates. Astra is excluded from prototyping.
4. Choose manual attachment or approve on-demand launch, save, and restart Chopin.

In local workspace mode, ordinary Chat messages go to the configured Planner;
`@chopin` is not required. Each root document keeps its own conversation, and child
context uses the root's Chat. The classifier helps turn requests for human input
into Decision cards. Agent questions and command approvals also appear as Decisions.

The Planner reads registered source without write access. Prototyping runs in an
independent copy. Applying a checkpoint requires a human Decision and a check that
the original files still match their baseline. You then commit manually; Chopin
verifies the commit before allowing the next checkpoint. This workflow does not
stage, commit, or push the original repository.

See [local workspace setup](docs/local-workspace.md#configure-chat-and-ai-roles)
for MCP configuration, manual attachment, sandbox requirements, and supported
connection behavior.

### Keep the app running on Linux

After preparing the app, stop any foreground instance and install its systemd
user service:

```bash
bun run workspace service install
bun run workspace service status
```

Use `bun run workspace service restart` after rebuilding or changing AI settings.
The service requires this checkout, Bun, dependencies, and PostgreSQL to remain
available. App service installation currently supports Linux only; macOS and
Windows use foreground startup. See
[background startup](docs/local-workspace.md#keep-chopin-running-on-linux) for
logs, boot behavior, and removal.

### Settings and limits

- Local mode has one owner and no shared-team authentication or GitLab API
  integration. Hosted research, summaries, builds, and automatic jobs stay off.
- Workspace settings, the access key, database URL, and AI selections are generated
  outside the checkout, by default under `~/.local/state/chopin/workspace/`.
  `XDG_STATE_HOME` or `CHOPIN_WORKSPACE_DIR` can select another location. Keep
  credentials and personal configuration out of Git.
- Codex tools have networking disabled. ACP agents and inherited local stdio MCP
  servers require process confinement; a missing sandbox refuses their launch.
  See [sandbox and MCP boundaries](docs/local-workspace.md#configured-mcp-tools).
- Access from another computer uses a tunnel to the loopback server. The launcher
  does not configure public hosting. See
  [remote access](docs/local-workspace.md#use-it-from-outside).

## GitHub-connected mode

The original mode remains available when `CHOPIN_MODE` is unset. It uses a
GitHub App for browser sign-in and repository access, supports team collaboration,
and offers hosted research and machine-based work. GitHub.com is supported;
GitHub Enterprise Server endpoints are not configurable.

For the development path, install Bun 1.4.4 and Docker Compose, then register a
GitHub App using the permissions and settings in
[Authentication](docs/authentication.md#repository-permissions). Its local URLs are:

```text
Homepage:  http://127.0.0.1:8787
Callback:  http://127.0.0.1:8787/auth/github/callback
Setup URL: http://127.0.0.1:8787/auth/github/setup
```

Configure and start from the checkout:

```bash
bun install --frozen-lockfile
cp .env.example .env
openssl rand -hex 32
# Fill in the GitHub App values, generated session key, and classifier
# credentials (OPENAI_API_KEY or JEV_API_KEY) in .env.
bun run db:up
bun run migrate
bun run dev
```

The default Planner harness also requires an active Copilot entitlement. Alternate
harnesses have their own configuration and credential requirements; see
[Self-hosting](docs/self-hosting.md#choose-and-trust-a-harness). The local Compose
override exposes database port 5432 on the host, so use it on a trusted development
machine. Follow [Self-hosting](docs/self-hosting.md) for deployment instructions.

In GitHub-connected mode:

- `@chopin` addresses the Planner; other Chat messages provide bounded context for
  its next turn. Optional automatic participation is described in
  [Conversation initiative](docs/conversation-initiative.md).
- The default `copilot-sdk` Planner reads repository content through bounded GitHub
  tools. It does not edit a local checkout. `HARNESS=atomic` gives it full Atomic
  tools as the server's user; `HARNESS=remote` runs turns in an attached agent.
- `/research` starts durable research requests. Completed research appears as a
  child document with its own document and Decisions; Chat stays on the root.
  Public search depends on the configured GitHub Copilot MCP access; see
  [research troubleshooting](docs/self-hosting.md#troubleshooting).
- Browser users need access through the GitHub App installation. MCP callers use
  their own GitHub bearer token and repository permissions.
- One active application process writes to each PostgreSQL database. Horizontal
  application scaling is not supported.

### Connect a machine

The **Machines** page on a GitHub-connected server provides commands to install
the connector CLI, pair a machine, and optionally keep it connected as a service.
Install and sign in to the coding agent first. For example, with Copilot:

```bash
curl -fsSL https://github.com/githubnext/chopin/releases/latest/download/install.sh | sh
CHOPIN_URL=https://your-chopin-instance.example chopin connect --agent copilot
```

These installers download upstream `githubnext/chopin` CLI releases. They do not
install the local workspace app or publish a release of this checkout. See
[the CLI guide](docs/chopin-cli.md) for Windows, other ACP agents, pairing, and
background services.

## Documentation

| Topic                                               | Document                                                     |
| --------------------------------------------------- | ------------------------------------------------------------ |
| Local workspace setup, AI, prototypes, and services | [Local workspaces](docs/local-workspace.md)                  |
| Deploy and operate a GitHub-connected instance      | [Self-hosting](docs/self-hosting.md)                         |
| Configure GitHub identity and access                | [Authentication](docs/authentication.md)                     |
| Connect an external coding agent through MCP        | [Local agent MCP](docs/local-agent-mcp.md)                   |
| Attach a remote Planner                             | [Agent connection](docs/agent-connection.md)                 |
| Connect a machine to a server                       | [chopin CLI](docs/chopin-cli.md)                             |
| Understand the system                               | [Architecture](docs/architecture.md)                         |
| Understand document identity and access             | [Repository channels](docs/channels.md)                      |
| Understand persistence                              | [Storage](docs/storage.md)                                   |
| Capture and record open decisions                   | [Decisions](docs/decisions.md)                               |
| Review the hosted agent boundary                    | [Hosted agent](docs/hosted-agent.md)                         |
| Review experimental build workflows                 | [Implementation lifecycle](docs/implementation-lifecycle.md) |
| Run machine-based investigations                    | [Local investigations](docs/local-experiments.md)            |
| Work on the repository                              | [Maintainer guide](AGENTS.md)                                |

## Development

```bash
bun test              # unit and in-memory adapter tests
bun run test:postgres # PostgreSQL storage contract and lifecycle tests
bun run e2e           # browser and system integration suite
bun run types         # TypeScript checks across the workspace
bun run ci            # formatting, lint, tokens, and design checks
```

Run `bun run e2e:browsers` once to install Chromium. The browser suite builds
the client and starts disposable PostgreSQL services and application servers.
See [AGENTS.md](AGENTS.md) for repository structure, test selection, and current
engineering invariants.

Security reports should follow [SECURITY.md](SECURITY.md). Participation is
covered by the [Code of Conduct](CODE_OF_CONDUCT.md), and the source is available
under the [MIT License](LICENSE.md).
