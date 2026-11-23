import { tool } from "ai";
import { z } from "zod";
import { Checkpoints } from "./checkpoints";
import { workspaceRepositories } from "./config";
import { createHumanInput } from "../harness/atomic/human-input";
import { runLocalWorker } from "./ai-runtime";
import type { DocumentRoom } from "../agent/tools";
import type { ActiveOwnerBinding } from "../agent/active-owner";

let checkpoints: Checkpoints | undefined;
export function workspaceCheckpoints() {
	return checkpoints ??= new Checkpoints(workspaceRepositories(process.env.CHOPIN_WORKSPACES));
}
const contextSchema = z.object({
	room: z.custom<DocumentRoom>(),
	owner: z.custom<ActiveOwnerBinding>(),
	repository: z.object({ id: z.string() }),
});
const view = (record: Awaited<ReturnType<Checkpoints["get"]>>) => ({
	id: record.id,
	name: record.name,
	goal: record.goal,
	status: record.status,
	copy: record.copy,
	files: record.files?.slice(0, 100),
	changedFiles: record.files?.length,
	report: record.report,
	commitMessage: record.commitMessage,
	commit: record.commit,
});

export const localAiTools = {
	prototype_local: tool({
		contextSchema,
		description:
			"Run one bounded implementation/testing alternative using the configured Prototyping AI in an independent copy. Original files and Git state remain untouched. A pending manual commit blocks the next checkpoint. Never use an expensive substitute model; configuration selects the worker.",
		inputSchema: z.object({ name: z.string().min(1).max(100), goal: z.string().min(1).max(8000) })
			.strict(),
		execute: async (input, { context, abortSignal }) => {
			if (!await context.owner.revalidate()) throw new Error("Workspace authorization expired");
			let signal = AbortSignal.any([context.owner.signal, ...abortSignal ? [abortSignal] : []]);
			let record = await workspaceCheckpoints().create(
				context.room.id,
				context.repository.id,
				input.name,
				input.goal,
			);
			let report = await runLocalWorker(
				"prototyping",
				{
					channelId: context.room.id,
					repositoryId: context.repository.id,
					humanInput: createHumanInput(context.room),
					cwd: record.copy,
					writable: true,
				},
				`Experiment: ${input.name}\n\n${input.goal}\n\nWork only in ${record.copy}. Original checkout writes, commits and pushes are forbidden. Source copies omit .git, credentials and generated/dependency directories. Report any test that needs missing dependencies rather than weakening permissions.`,
				signal,
			);
			let sealed = await workspaceCheckpoints().seal(record.id, report);
			return { ...view(sealed), review: await workspaceCheckpoints().preview(record.id) };
		},
	}),
	list_local_checkpoints: tool({
		contextSchema,
		description:
			"Read this document's experiment alternatives and manual-commit checkpoint status.",
		inputSchema: z.object({}).strict(),
		execute: async (_input, { context }) =>
			(await workspaceCheckpoints().list(context.room.id)).map(view),
	}),
	apply_local_checkpoint: tool({
		contextSchema,
		description:
			"Ask the human to choose a sealed prototype as a sub-final checkpoint. Only a saved human Yes permits applying its exact reviewed files to the original checkout. Changes are refused if original files changed since the prototype. Approval covers file application only. The human stages and commits manually. Give the supplied commit message and stop at that checkpoint.",
		inputSchema: z.object({ id: z.string().uuid(), commitMessage: z.string().min(1).max(500) })
			.strict(),
		execute: async (input, { context, abortSignal }) => {
			let record = await workspaceCheckpoints().get(input.id);
			if (record.documentId !== context.room.id) {
				throw new Error("This checkpoint belongs to another document");
			}
			let signal = AbortSignal.any([context.owner.signal, ...abortSignal ? [abortSignal] : []]);
			let decisions: string[] = [];
			let approved = await createHumanInput(context.room).confirm(
				"Apply this prototype to the original checkout?",
				`${record.name}\n\n${record.files?.length ?? 0} changed files:\n${
					record.files?.slice(0, 40).map(file => file.path).join("\n")
				}\n\nYou will commit this checkpoint manually. Suggested commit message: ${input.commitMessage}\n\n${await workspaceCheckpoints()
					.preview(record.id)}`,
				{
					signal,
					sessionId: context.room.id,
					requestId: input.id,
					asked: ids => {
						decisions = ids;
					},
				},
			);
			if (!approved || signal.aborted || !await context.owner.revalidate()) {
				return { status: "not-applied" };
			}
			return {
				...view(
					await workspaceCheckpoints().apply(
						input.id,
						context.room.id,
						decisions,
						input.commitMessage,
					),
				),
				next:
					"Only the human may stage and commit these files. Give them the suggested commit message and stop. Call verify_local_commit after the human reports committing. Start the next checkpoint only after verification succeeds.",
			};
		},
	}),
	verify_local_commit: tool({
		contextSchema,
		description:
			"Verify a human's manual commit contains every file of the selected checkpoint before continuing. Reads local Git objects only; never stages, commits, fetches or pushes.",
		inputSchema: z.object({ id: z.string().uuid() }).strict(),
		execute: async (input, { context }) => {
			let record = await workspaceCheckpoints().get(input.id);
			if (record.documentId !== context.room.id) {
				throw new Error("This checkpoint belongs to another document");
			}
			return view(await workspaceCheckpoints().verifyCommit(input.id));
		},
	}),
};
