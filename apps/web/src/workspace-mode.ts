import { createContext, useContext } from "react";

/** The server's explicit local profile, shared with navigation and optional features. */
export const WorkspaceMode = createContext(false);

export function useWorkspaceMode(): boolean {
	return useContext(WorkspaceMode);
}
