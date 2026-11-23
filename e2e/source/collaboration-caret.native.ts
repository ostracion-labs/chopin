import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import * as Room from "../../apps/server/src/plan/room";

declare global {
	interface Window {
		caretFixture: {
			mount(epoch: string, snapshot: string): void;
			applyAgentUpdate(update: string): void;
			sharedCaretOffset(): number | undefined;
		};
	}
}

let script: string;
test.beforeAll(async () => {
	let entry = fileURLToPath(new URL("../../packages/editor/src/collaboration.tsx", import.meta.url));
	let result = await Bun.build({
		entrypoints: [entry],
		target: "browser",
		format: "iife",
		plugins: [{
			name: "collaboration-caret-fixture",
			setup(build) {
				build.onLoad({ filter: /\/collaboration\.tsx$/ }, async ({ path }) => ({
					loader: "tsx",
					contents: await Bun.file(path).text() + "\n" + fixture,
				}));
			},
		}],
	});
	expect(result.success, JSON.stringify(result.logs)).toBe(true);
	script = await result.outputs.find(output => output.path.endsWith(".js"))!.text();
});

test("a Planner edit preserves Ctrl+Arrow navigation before selectionchange", async ({ page }) => {
	let room = await Room.create("Alpha bravo charlie.\n");
	try {
		let snapshot = Buffer.from(room.checkpoint).toString("base64");
		let before: Parameters<typeof Room.reconcile>[1] = [{
			type: "paragraph",
			children: [{ type: "text", value: "Alpha bravo charlie." }],
		}];
		let delta = Room.reconcile(room, before, [...before, {
			type: "paragraph",
			children: [{ type: "text", value: "Added by Planner." }],
		}])!;
		await page.setContent('<!doctype html><div id="fixture"></div>');
		await page.addScriptTag({ content: script });
		await page.evaluate(({ epoch, snapshot }) => window.caretFixture.mount(epoch, snapshot), {
			epoch: room.epoch,
			snapshot,
		});
		let editor = page.locator("[contenteditable=true]");
		await expect(editor).toHaveText("Alpha bravo charlie.");
		await editor.click();
		await page.evaluate(() => {
			let selection = window.getSelection()!;
			selection.collapse(selection.anchorNode, 0);
		});
		await expect.poll(() => page.evaluate(() => window.caretFixture.sharedCaretOffset()))
			.toBe(0);

		// Hold only the browser notification so the remote edit reliably arrives first.
		await page.evaluate(() => {
			window.addEventListener("selectionchange", event => event.stopImmediatePropagation(), {
				capture: true,
			});
		});
		await page.keyboard.press(process.platform === "darwin" ? "Alt+ArrowRight" : "Control+ArrowRight");
		let offset = await page.evaluate(() => window.getSelection()!.anchorOffset);
		expect(offset).toBeGreaterThan(0);
		expect(await page.evaluate(() => window.caretFixture.sharedCaretOffset())).toBe(0);

		await page.evaluate(
			update => window.caretFixture.applyAgentUpdate(update),
			Buffer.from(delta.update).toString("base64"),
		);
		await expect(editor).toContainText("Added by Planner.");
		expect(await page.evaluate(() => {
			let selection = window.getSelection()!;
			return { text: selection.anchorNode?.textContent, offset: selection.anchorOffset };
		})).toEqual({ text: "Alpha bravo charlie.", offset });
		expect(await page.evaluate(() => window.caretFixture.sharedCaretOffset())).toBe(offset);
	} finally {
		room.doc.destroy();
	}
});

let fixture = `
import { MDXEditor } from "@mdxeditor/editor";
import { createRoot } from "react-dom/client";
window.caretFixture = {
 mount(epoch, snapshot) {
  let listeners = new Map();
  let wire = {
   on(kind, listener) { listeners.set(kind, listener); return () => listeners.delete(kind); },
   ask: async () => ({ epoch, update: snapshot, anchors: [], threads: [], prose: [] }),
   send() {},
  };
  let binding, provider;
  this.sharedCaretOffset = () => binding?.editor.getEditorState().read(() => {
   let state = provider.awareness.getLocalState();
   if (state?.anchorPos) return $getAnchorAndFocusForUserState(binding, state).anchorOffset;
  });
  // A DOM event gives this the same event context as a WebSocket delivery.
  let socket = new EventTarget();
  socket.addEventListener("message", event => listeners.get("plan:update")?.(event.data));
  this.applyAgentUpdate = update => socket.dispatchEvent(new MessageEvent("message", {
   data: { epoch, update, agent: true },
  }));
  let plugin = collaborationPlugin({ wire, user: { name: "Reader", color: "blue" },
   onBinding: value => binding = value, onProvider: value => provider = value });
  createRoot(document.querySelector("#fixture")).render(
   <MDXEditor markdown="" editorState={null} suppressSharedHistory plugins={[plugin]} />,
  );
 },
};
`;
