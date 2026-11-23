import { GitHubError } from "../github/client";
import { matchesWorkspaceToken } from "./config";

import type { GitHub, GitHubInstallation, GitHubTokenGrant, Repository } from "../github/client";
import type { WorkspaceConfig } from "./config";

/**
 * Contained compatibility boundary for the existing document/session DTOs. These are local
 * identities and document permissions, never a claim of a GitHub installation or Git push access.
 * Connector, implementation and Planner endpoints must remain unavailable in workspace mode.
 */
export class WorkspaceAuthority implements GitHub {
	readonly userProfile = { id: "workspace:owner", login: "local-owner", avatarUrl: "" };
	readonly #config: WorkspaceConfig;
	readonly #origin: string;

	constructor(config: WorkspaceConfig, origin: string) {
		this.#config = config;
		this.#origin = origin;
	}

	#check(token: string): void {
		if (!matchesWorkspaceToken(this.#config.token, token)) {
			throw new GitHubError("Invalid local workspace credential", 401);
		}
	}

	grant(token: string): GitHubTokenGrant {
		this.#check(token);
		return {
			accessToken: token,
			refreshToken: token,
			accessExpiresIn: 86400,
			refreshExpiresIn: 30 * 86400,
		};
	}

	authorize(): never {
		throw new Error("OAuth is unavailable in workspace mode");
	}

	async exchange(): Promise<never> {
		throw new Error("OAuth is unavailable in workspace mode");
	}

	async refresh(input: { refreshToken: string }): Promise<GitHubTokenGrant> {
		return this.grant(input.refreshToken);
	}

	async user(token: string) {
		this.#check(token);
		return this.userProfile;
	}

	async organizationMembership(token: string) {
		this.#check(token);
		return undefined;
	}

	async installations(token: string, page: number) {
		this.#check(token);
		let installation: GitHubInstallation = {
			id: "1",
			account: { login: "Local checkouts", avatarUrl: "", type: "user" },
			repositorySelection: "selected",
			configureUrl: "/",
			suspended: false,
			permissions: {
				contents: true,
				pullRequests: false,
				checks: false,
				statuses: false,
				issues: false,
			},
		};
		return { installations: page === 1 ? [installation] : [], nextPage: undefined };
	}

	async installationRepositories(token: string, installationId: string, page: number) {
		this.#check(token);
		if (installationId !== "1") throw new GitHubError("Workspace not found", 404);
		let repositories = page === 1
			? await Promise.all(this.#config.repositories.map(record => {
				let [owner, name] = record.name.split("/");
				return this.repository(token, owner!, name!);
			}))
			: [];
		return { repositories, nextPage: undefined };
	}

	async repository(token: string, owner: string, name: string): Promise<Repository> {
		this.#check(token);
		let record = this.#config.repositories.find(item =>
			item.name === `${owner}/${name}`.toLowerCase()
		);
		if (!record) throw new GitHubError("Workspace checkout not found", 404);
		let [localOwner, localName] = record.name.split("/");
		return {
			id: record.id,
			owner: localOwner!,
			name: localName!,
			fullName: record.name,
			private: true,
			url: `${this.#origin}/documents/${record.name}`,
			defaultBranch: "",
			// Legacy document-write capability. It grants no Git or connector capability.
			permissions: { pull: true, push: true, admin: false },
		};
	}

	async repositoryAccess(token: string, owner: string, name: string) {
		try {
			return await this.repository(token, owner, name);
		} catch (error) {
			if (error instanceof GitHubError && error.status === 404) return undefined;
			throw error;
		}
	}

	invalidate(): void {}
}
