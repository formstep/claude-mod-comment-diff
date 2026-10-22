import type { On, RenderElement } from "claude-code";
import { expect, test } from "claude-code/testing";
import type { Engine, Mounted } from "claude-code/testing";

const PLUGIN = "comment-diff";

const EDIT_OUTPUT = {
  filePath: "/repo/src/thing.tsx",
  oldString: "old",
  newString: "new",
  originalFile: "keep\nold\ntail\n",
  userModified: false,
  replaceAll: false,
  structuredPatch: [
    {
      oldStart: 10,
      oldLines: 3,
      newStart: 10,
      newLines: 3,
      lines: [" keep", "-old", "+new", " tail"],
    },
  ],
};

const DIFF = {
  plugin: PLUGIN,
  surface: "terminal",
  component: "ToolResult",
  requestId: "toolu_1",
  props: { tool_use_id: "toolu_1", tool: "Edit", output: EDIT_OUTPUT, isErrored: false },
} as const;

const FOOTER = {
  plugin: PLUGIN,
  surface: "terminal",
  component: "PromptHint",
  props: { isDraft: false, isWorking: false, hint: "? for shortcuts" },
} as const;

const PANE = {
  plugin: PLUGIN,
  surface: "terminal",
  component: "Pane",
  requestId: "diff-comment",
  props: {
    title: "c1",
    isFocused: true,
    bodyColumns: 80,
    placement: "inline",
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
} as const;

const TURN_DONE = {
  answer: "done",
  durationMs: 10,
  isAborted: false,
  turnId: "t1",
  reason: "answer",
} as const;

const ENGINE_HINT: RenderElement = { type: "Text", props: {}, children: ["? for shortcuts"] };

type Diff = Mounted<"terminal", "ToolResult">;

function engineBeneath(on: On) {
  const prompts: string[] = [];
  const promptBoxWrites: string[] = [];
  const opened: { id: string; title?: string; focus?: true; closeOnEscape?: true }[] = [];
  const closed: string[] = [];

  on("prompt.fill", (_$, e) => {
    promptBoxWrites.push(e.text);
    return { isFilled: true };
  });
  on("prompt.submit", (_$, e) => {
    prompts.push(e.text);
    return { text: e.text };
  });
  on("ui.open", (_$, e) => {
    opened.push(e);
    return { value: { isPlaced: true } } as const;
  });
  on("ui.close", (_$, e) => {
    closed.push(e.id);
    return { value: undefined };
  });
  on("clock.after", () => ({ value: undefined }));
  on("ui.render", { component: "PromptHint" }, () => ENGINE_HINT);

  return { prompts, promptBoxWrites, opened, closed, panes: () => opened.map((o) => o.id) };
}

const typed = (text: string) => ({ text, origin: { kind: "composer" }, wait: false }) as const;

// The whole diff is one Client.
const VIEW = "diff-toolu_1-0";

type Pane = Mounted<"terminal", "Pane">;
const INPUT = "comment-input";
const SEND_NOW = "comment-send-now";

type Send = "enter" | "ctrl+enter";

// Enter submits the field; Ctrl+Enter is the chord of the send-now Button.
async function write(pane: Pane, text: string, send: Send = "enter") {
  if (send === "enter") {
    await pane.input({ key: INPUT, text });
    return;
  }

  await pane.input({ key: INPUT, text, kind: "change" });
  await pane.press({ key: SEND_NOW });
}

// Presses a +, reply or edit in the diff and writes `body` in the pane it opens.
async function comment($: Engine, diff: Diff, button: string, body: string, send: Send = "enter") {
  await diff.press({ key: button });
  const pane = await $.ui.mount(PANE);
  await write(pane, body, send);
  await pane.unmount();
}

test("+ opens a focused pane on the line's file and line, and Enter there adds a pending comment", async ($, on) => {
  const { prompts, promptBoxWrites, opened, closed } = engineBeneath(on);
  const diff = await $.ui.mount(DIFF);

  expect(await diff.findAll({ type: "Code", in: VIEW })).toHaveLength(4);

  await diff.press({ key: "add-2" });
  expect(opened).toMatchObject([
    { id: "diff-comment", title: "New comment · thing.tsx:11", focus: true, closeOnEscape: true },
  ]);

  const pane = await $.ui.mount(PANE);
  expect(await pane.find({ type: "Text", text: "thing.tsx:11" })).toBeDefined();
  expect(await pane.findAll({ type: "Code" })).toHaveLength(4);
  expect((await pane.find({ key: INPUT }))?.props.autoFocus).toBe(true);
  expect((await pane.find({ key: "comment-save" }))?.text).toBe("Enter add to review queue");
  expect((await pane.find({ key: SEND_NOW }))?.props.action).toBe("chat:sendNow");
  expect((await pane.find({ key: "comment-cancel" }))?.text).toBe("Esc cancel");

  await write(pane, "Name this better");
  expect(closed).toEqual(["diff-comment"]);
  expect(prompts).toEqual([]);
  expect(promptBoxWrites).toEqual([]);
  expect(await diff.find({ type: "Text", text: "c1", in: VIEW })).toBeDefined();
  expect(await diff.find({ type: "Text", text: "Name this better", in: VIEW })).toBeDefined();

  const footer = await $.ui.mount(FOOTER);
  expect((await footer.find({ key: "go-c1" }))?.text).toContain("thing.tsx:11");
  expect((await footer.find({ key: "submit-review" }))?.props.label).toBe("Submit review (1)");
});

test("Ctrl+Enter sends the comment to Claude at once, its lines kept", async ($, on) => {
  const { prompts } = engineBeneath(on);
  const diff = await $.ui.mount(DIFF);

  await diff.press({ key: "add-2" });
  const pane = await $.ui.mount(PANE);
  await write(pane, "Use a\nlookup", "ctrl+enter");

  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain("[c1] /repo/src/thing.tsx:11");
  expect(prompts[0]).toContain("Use a\nlookup");

  const footer = await $.ui.mount(FOOTER);
  expect(await footer.find({ type: "Text", text: "0 pending · 1 sent · 0 resolved" })).toBeDefined();
  expect(await footer.find({ key: "submit-review" })).toBeUndefined();
});

test("Ctrl+Enter while Claude works rides on the next tool result, not a prompt for later", async ($, on) => {
  const { prompts } = engineBeneath(on);
  on("turn.start", (_$, e) => ({ turnId: e.turnId }));
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  on("tool.call", () => ({ result: "file.txt" }));
  const diff = await $.ui.mount(DIFF);

  await $.turn.start({ text: "do the thing", turnId: "t1" });
  await comment($, diff, "add-2", "Stop, wrong file", "ctrl+enter");
  expect(prompts).toEqual([]);

  const toolResult = await $.tool.call({ tool: "Bash", command: "ls" });
  expect(toolResult.context?.join("\n")).toContain("Stop, wrong file");

  const later = await $.tool.call({ tool: "Bash", command: "ls" });
  expect(later.context).toBeUndefined();

  await $.turn.complete(TURN_DONE);
  expect(prompts).toEqual([]);
});

test("Ctrl+Enter while Claude works is sent as a prompt when the turn ends without a tool call", async ($, on) => {
  const { prompts } = engineBeneath(on);
  on("turn.start", (_$, e) => ({ turnId: e.turnId }));
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  const diff = await $.ui.mount(DIFF);

  await $.turn.start({ text: "do the thing", turnId: "t1" });
  await comment($, diff, "add-2", "Also this", "ctrl+enter");
  expect(prompts).toEqual([]);

  await $.turn.complete(TURN_DONE);
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain("Also this");
});

test("an empty comment adds nothing and keeps the pane open", async ($, on) => {
  const { closed } = engineBeneath(on);
  const diff = await $.ui.mount(DIFF);

  await diff.press({ key: "add-0" });
  const pane = await $.ui.mount(PANE);
  await write(pane, "   ");
  await write(pane, "   ", "ctrl+enter");

  expect(closed).toEqual([]);
  expect(await pane.find({ key: INPUT })).toBeDefined();
  const footer = await $.ui.mount(FOOTER);
  expect(await footer.drawn()).toMatchObject(ENGINE_HINT);
});

test("a send that never arrives leaves the comment pending and unread, a reply made meanwhile included", async ($, on) => {
  const prompts: string[] = [];
  let isDropping = true;
  on("prompt.submit", (_$, e) => {
    if (isDropping) {
      return { drop: "Claude is busy" };
    }

    prompts.push(e.text);
    return { text: e.text };
  });
  on("ui.open", () => ({ value: { isPlaced: true } }) as const);
  on("ui.close", () => ({ value: undefined }));
  on("ui.render", { component: "PromptHint" }, () => ENGINE_HINT);
  const diff = await $.ui.mount(DIFF);

  await comment($, diff, "add-2", "Test1");
  const footer = await $.ui.mount(FOOTER);
  await footer.press({ key: "submit-review" });
  await comment($, diff, "reply-2", "Test2");
  expect(await footer.find({ type: "Text", text: "1 pending · 0 sent · 0 resolved" })).toBeDefined();

  isDropping = false;
  await footer.press({ key: "submit-review" });
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain("Test1\n\nTest2");
  expect(prompts[0]).not.toContain("Already sent");
});

test("reply adds to the line's comment instead of making a new one, and the overview shows both", async ($, on) => {
  const { prompts, opened } = engineBeneath(on);
  const diff = await $.ui.mount(DIFF);
  await comment($, diff, "add-2", "Test1");
  const footer = await $.ui.mount(FOOTER);
  await footer.press({ key: "submit-review" });

  await diff.press({ key: "reply-2" });
  expect(opened.at(-1)?.title).toBe("Reply to c1 · thing.tsx:11");
  const pane = await $.ui.mount(PANE);
  expect(await pane.find({ type: "Text", text: "Test1" })).toBeDefined();
  await write(pane, "Test2");
  await pane.unmount();

  await comment($, diff, "add-2", "Test3");

  expect(await footer.find({ key: "go-c2" })).toBeUndefined();
  expect((await footer.find({ key: "go-c1" }))?.text).toContain("Test1 · Test2 · Test3");
  expect(await footer.find({ type: "Text", text: "1 pending · 0 sent · 0 resolved" })).toBeDefined();

  await footer.press({ key: "submit-review" });
  expect(prompts[1]).toContain("[c1] /repo/src/thing.tsx:11");
  expect(prompts[1]).toContain("Already sent:\n> Test1\n\nNew:\nTest2\n\nTest3");
});

test("edit changes the comment's last message; an edit Claude has read goes out again", async ($, on) => {
  const { prompts, opened } = engineBeneath(on);
  const diff = await $.ui.mount(DIFF);
  await comment($, diff, "add-2", "Rename");

  await diff.press({ key: "edit-c1" });
  expect(opened.at(-1)?.title).toBe("Edit c1 · thing.tsx:11");
  const pane = await $.ui.mount(PANE);
  expect((await pane.find({ key: INPUT }))?.props.value).toBe("Rename");
  expect((await pane.find({ key: "comment-save" }))?.text).toBe("Enter save");
  await write(pane, "Rename it");
  await pane.unmount();
  expect(await diff.find({ type: "Text", text: "Rename it", in: VIEW })).toBeDefined();

  const footer = await $.ui.mount(FOOTER);
  await footer.press({ key: "submit-review" });
  expect(prompts[0]).not.toContain("edited");

  await comment($, diff, "edit-c1", "Rename it to total");
  expect(await footer.find({ type: "Text", text: "1 pending · 0 sent · 0 resolved" })).toBeDefined();

  await footer.press({ key: "submit-review" });
  expect(prompts[1]).toContain("[c1] /repo/src/thing.tsx:11 (edited since you read it)");
  expect(prompts[1]).toContain("Rename it to total");
});

test("a reply to a resolved comment reopens it", async ($, on) => {
  engineBeneath(on);
  const diff = await $.ui.mount(DIFF);
  await comment($, diff, "add-3", "Fine as is");

  const footer = await $.ui.mount(FOOTER);
  await footer.press({ key: "resolve-c1" });
  expect(await footer.find({ key: "delete-c1" })).toBeUndefined();

  await comment($, diff, "reply-3", "Not quite");

  expect(await footer.find({ type: "Text", text: "1 pending · 0 sent · 0 resolved" })).toBeDefined();
  expect(await footer.find({ key: "delete-c1" })).toBeDefined();
  expect(await diff.find({ type: "Text", text: "resolved by you", in: VIEW })).toBeUndefined();
});

test("a comment in the overview opens the edit pane, and the prompt never touches the comment", async ($, on) => {
  const { prompts, opened } = engineBeneath(on);
  const diff = await $.ui.mount(DIFF);
  await comment($, diff, "add-2", "Test1");

  const footer = await $.ui.mount(FOOTER);
  await footer.press({ key: "go-c1" });
  expect(opened.at(-1)).toMatchObject({
    title: "Edit c1 · thing.tsx:11",
    focus: true,
    closeOnEscape: true,
  });

  const pane = await $.ui.mount(PANE);
  expect(await pane.findAll({ type: "Code" })).toHaveLength(4);
  expect((await pane.find({ key: INPUT }))?.props).toMatchObject({ autoFocus: true, value: "Test1" });
  expect(await pane.find({ key: "pane-resolve" })).toBeDefined();
  expect(await pane.find({ key: "pane-delete" })).toBeDefined();

  const entered = await $.prompt.submit(typed("an ordinary prompt"));
  expect(entered.drop).toBeUndefined();
  expect(prompts).toEqual(["an ordinary prompt"]);
  expect((await footer.find({ key: "go-c1" }))?.text).not.toContain("ordinary");

  await write(pane, "Test1 rewritten");
  expect((await footer.find({ key: "go-c1" }))?.text).toContain("Test1 rewritten");
  expect(await footer.find({ type: "Text", text: "1 pending · 0 sent · 0 resolved" })).toBeDefined();
});

test("Resolve and Delete in the edit pane act on the comment and close the pane", async ($, on) => {
  const { closed, opened } = engineBeneath(on);
  const diff = await $.ui.mount(DIFF);
  await comment($, diff, "add-2", "Test1");
  await comment($, diff, "add-3", "Test2");
  const footer = await $.ui.mount(FOOTER);

  await footer.press({ key: "go-c1" });
  let pane = await $.ui.mount(PANE);
  closed.length = 0;
  await pane.press({ key: "pane-resolve" });
  expect(closed).toEqual(["diff-comment"]);
  expect(await footer.find({ type: "Text", text: "1 pending · 0 sent · 1 resolved" })).toBeDefined();
  await pane.unmount();

  // A resolved comment cannot be edited, so it opens a reply, which reopens it.
  await footer.press({ key: "go-c1" });
  expect(opened.at(-1)?.title).toBe("Reply to c1 · thing.tsx:11");
  pane = await $.ui.mount(PANE);
  expect(await pane.find({ key: "pane-resolve" })).toBeUndefined();
  await pane.unmount();

  await footer.press({ key: "go-c2" });
  pane = await $.ui.mount(PANE);
  closed.length = 0;
  await pane.press({ key: "pane-delete" });
  expect(closed).toEqual(["diff-comment"]);
  expect(await footer.find({ key: "go-c2" })).toBeUndefined();
});

test("deleting a comment closes the pane replying to or editing it, and no other", async ($, on) => {
  const { closed } = engineBeneath(on);
  const diff = await $.ui.mount(DIFF);
  await comment($, diff, "add-2", "Test1");
  await comment($, diff, "add-3", "Test2");
  const footer = await $.ui.mount(FOOTER);
  closed.length = 0;

  await diff.press({ key: "reply-2" });
  await footer.press({ key: "delete-c2" });
  expect(closed).toEqual([]);
  await footer.press({ key: "delete-c1" });
  expect(closed).toEqual(["diff-comment"]);

  await comment($, diff, "add-3", "Test3");
  closed.length = 0;
  await diff.press({ key: "edit-c3" });
  await footer.press({ key: "delete-c3" });
  expect(closed).toEqual(["diff-comment"]);
});

test("Submit review sends pending comments, Claude resolves them, and only unresolved ones can be deleted or edited", async ($, on) => {
  const { prompts } = engineBeneath(on);
  const diff = await $.ui.mount(DIFF);

  await comment($, diff, "add-2", "Rename");
  await comment($, diff, "add-1", "Why remove this?");

  const footer = await $.ui.mount(FOOTER);
  await footer.press({ key: "submit-review" });

  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain("[c1] /repo/src/thing.tsx:11");
  expect(prompts[0]).toContain("[c2] /repo/src/thing.tsx:11 (removed line)");
  expect(prompts[0]).toContain("mcp__comment-diff__resolve");
  expect(await footer.find({ type: "Text", text: "0 pending · 2 sent · 0 resolved" })).toBeDefined();

  const answer = await $.tool.call({
    tool: "mcp__comment-diff__resolve",
    ids: ["c1", "c9"],
    note: "Renamed it",
  });
  expect(answer.result).toBe("Resolved c1. No such comment (the person may have deleted it): c9.");

  expect(await footer.find({ key: "delete-c1" })).toBeUndefined();
  expect(await diff.find({ key: "edit-c1", in: VIEW })).toBeUndefined();
  expect(await diff.find({ type: "Text", text: "resolved by Claude: Renamed it", in: VIEW })).toBeDefined();

  await footer.press({ key: "delete-c2" });
  expect(await footer.find({ key: "go-c2" })).toBeUndefined();
  expect(await footer.find({ type: "Text", text: "0 pending · 0 sent · 1 resolved" })).toBeDefined();
});

test("the person can resolve a comment themselves", async ($, on) => {
  engineBeneath(on);
  const diff = await $.ui.mount(DIFF);
  await comment($, diff, "add-3", "Fine as is");

  const footer = await $.ui.mount(FOOTER);
  await footer.press({ key: "resolve-c1" });

  expect(await footer.find({ key: "delete-c1" })).toBeUndefined();
  expect(await diff.find({ type: "Text", text: "resolved by you", in: VIEW })).toBeDefined();
});

// A new file long enough that one view's tree would pass the engine's bound.
const LONG_WRITE = {
  ...DIFF,
  requestId: "toolu_long",
  props: {
    tool_use_id: "toolu_long",
    tool: "Write",
    isErrored: false,
    output: {
      type: "create",
      filePath: `/repo/${"nested/".repeat(12)}long.ts`,
      content: Array.from({ length: 600 }, (_, i) => `export const value${i} = "line ${i}";\n`).join(""),
      structuredPatch: [],
      originalFile: null,
    },
  },
} as const;

test("a long diff is split across views: every line keeps its +, and a comment at a cut keeps its context", async ($, on) => {
  engineBeneath(on);
  const diff = await $.ui.mount(LONG_WRITE);
  const views = await diff.findAll({ type: "Client" });
  expect(views.length).toBeGreaterThan(1);

  let pluses = 0;

  for (const view of views) {
    const buttons = await diff.findAll({ type: "Button", in: String(view.props.key) });
    pluses += buttons.filter((b) => String(b.props.key).startsWith("add-")).length;
  }

  expect(pluses).toBe(600);

  // The first line of the second view, then the last line of the first.
  const second = String(views[1]?.props.key);
  const cut = Number(second.split("-").at(-1));

  for (const index of [cut, cut - 1]) {
    await diff.press({ key: `add-${index}` });
    const pane = await $.ui.mount(PANE);
    await write(pane, "At the cut");
    await pane.unmount();
  }

  const footer = await $.ui.mount(FOOTER);

  for (const id of ["c1", "c2"]) {
    await footer.press({ key: `go-${id}` });
    const pane = await $.ui.mount(PANE);
    expect(await pane.findAll({ type: "Code" })).toHaveLength(7);
    await pane.unmount();
  }
});

test("errored calls and other tools keep the engine's own drawing", async ($, on) => {
  engineBeneath(on);
  const engineDrawn: RenderElement = { type: "Text", props: {}, children: ["engine"] };
  on("ui.render", { component: "ToolResult" }, () => engineDrawn);

  const errored = await $.ui.mount({ ...DIFF, props: { ...DIFF.props, isErrored: true } });
  expect(await errored.drawn()).toMatchObject(engineDrawn);

  const bash = await $.ui.mount({
    ...DIFF,
    requestId: "toolu_2",
    props: { ...DIFF.props, tool: "Bash", output: { stdout: "" } },
  });
  expect(await bash.drawn()).toMatchObject(engineDrawn);
});
