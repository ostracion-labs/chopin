import type { HumanInput } from "../atomic/human-input";

export type CodexPlanner = {
	channelId: string;
	repositoryId: string;
	humanInput: HumanInput;
	/** A server-created experiment copy. Originals are never writable by an agent process. */
	cwd?: string;
	writable?: boolean;
	ephemeral?: boolean;
	nativeTools?: boolean;
	/** Host tools and the verified confined MCP catalog for the running turn's Chat guard. */
	activeTools?: readonly string[];
};

const planners = new Map<string, CodexPlanner>();

export function registerCodexPlanner(id: string, planner: CodexPlanner): () => void {
	if (planners.has(id)) throw new Error("Codex Planner is already registered");
	planners.set(id, planner);
	return () => {
		planners.delete(id);
	};
}

export function codexPlanner(id: string): CodexPlanner {
	let planner = planners.get(id);
	if (!planner) throw new Error("Codex can run only an explicitly requested local document turn.");
	return planner;
}
