/** Local, single-owner AI settings. Secrets belong to the runtime's login, never this DTO. */
export type AiRole = "planner" | "classifier" | "prototyping";
export type AiChoice = { connection: string; model: string; thinkingLevel?: string };
export type AiModel = { id: string; name: string; thinkingLevels?: string[] };
export type AiConnection = {
	id: string;
	name: string;
	transport: "codex" | "acp";
	command: string[];
	mode: "launch" | "attach";
	modelHosts: string[];
	models: AiModel[];
	registeredAt?: string;
	launchApproved: boolean;
};
export type LocalAiConfiguration = {
	version: 1;
	revision: number;
	connections: AiConnection[];
	roles: Partial<Record<AiRole, AiChoice>>;
};
export type LocalCheckpoint = {
	id: string;
	documentId: string;
	repositoryId: string;
	name: string;
	goal: string;
	copy: string;
	status: "prototype" | "applying" | "awaiting-commit" | "committed" | "conflict";
	baseHead: string;
	commit?: string;
	commitMessage?: string;
	created: string;
	files?: {
		path: string;
		before: string | null;
		after: string | null;
		beforeMode?: number | null;
		afterMode?: number | null;
	}[];
};
