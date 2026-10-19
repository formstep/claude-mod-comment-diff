import type { On, RenderElement } from "claude-code";
import { expect, test } from "claude-code/testing";
import type { Mounted } from "claude-code/testing";

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
  const panes: string[] = [];

  on("prompt.fill", (_$, e) => {
    promptBoxWrites.push(e.text);
    return { isFilled: true };
  });
  on("prompt.submit", (_$, e) => {
    prompts.push(e.text);
    return { text: e.text };
  });
  on("ui.open", (_$, e) => {
    panes.push(e.id);
    return { value: { isPlaced: true } } as const;
  });
  on("ui.close", () => ({ value: undefined }));
  on("clock.after", () => ({ value: undefined }));
  on("ui.render", { component: "PromptHint" }, () => ENGINE_HINT);

  return { prompts, promptBoxWrites, panes };
}

const typed = (text: string) => ({ text, origin: { kind: "composer" }, wait: false }) as const;

// The whole diff is one Client, so a click on + puts the keyboard in its box.
const VIEW = "diff-toolu_1-0";

async function type(diff: Diff, text: string) {
  for (const key of text) {
    await diff.key({ key });
  }
}

async function comment(diff: Diff, button: string, body: string, mode = "comment-review") {
  await diff.press({ key: button });
  await type(diff, body);
  await diff.press({ key: mode });
}

test("+ opens a box of its own under the line, apart from the prompt box, and Start a review adds a pending comment", async ($, on) => {
  const { prompts, promptBoxWrites } = engineBeneath(on);
  const diff = await $.ui.mount(DIFF);

  expect(await diff.findAll({ type: "Code", in: VIEW })).toHaveLength(4);
  expect(await diff.find({ key: "comment-cancel", in: VIEW })).toBeUndefined();

  await diff.press({ key: "add-2" });
  expect((await diff.find({ key: "comment-review", in: VIEW }))?.props.label).toBe(
    "Start a review",
  );

  await type(diff, "Name this better");
  expect(
    await diff.find({ type: "Text", text: "Name this better", in: VIEW }),
  ).toBeDefined();

  await $.prompt.submit(typed("an ordinary prompt"));
  expect(prompts).toEqual(["an ordinary prompt"]);
  expect(
    await diff.find({ type: "Text", text: "an ordinary prompt", in: VIEW }),
  ).toBeUndefined();

  await diff.press({ key: "comment-review" });
  expect(promptBoxWrites).toEqual([]);
  expect(await diff.find({ key: "comment-cancel", in: VIEW })).toBeUndefined();
  expect(await diff.find({ type: "Text", text: "c1", in: VIEW })).toBeDefined();

  const footer = await $.ui.mount(FOOTER);
  expect((await footer.find({ key: "go-c1" }))?.text).toContain("thing.tsx:11");
  expect((await footer.find({ key: "submit-review" }))?.props.label).toBe("Submit review (1)");

  await diff.press({ key: "add-1" });
  expect((await diff.find({ key: "comment-review", in: VIEW }))?.props.label).toBe(
    "Add review comment",
  );
});

test("Add single comment sends it to Claude at once", async ($, on) => {
  const { prompts } = engineBeneath(on);
  const diff = await $.ui.mount(DIFF);

  await comment(diff, "add-2", "Use a lookup", "comment-single");

  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain("[c1] /repo/src/thing.tsx:11");
  expect(prompts[0]).toContain("Use a lookup");

  const footer = await $.ui.mount(FOOTER);
  expect(await footer.find({ type: "Text", text: "0 pending · 1 sent · 0 resolved" })).toBeDefined();
  expect(await footer.find({ key: "submit-review" })).toBeUndefined();
});

test("Enter adds the comment to the review, shift+Enter starts a new line, Ctrl+Enter sends it", async ($, on) => {
  const { prompts } = engineBeneath(on);
  const diff = await $.ui.mount(DIFF);

  await diff.press({ key: "add-3" });
  await type(diff, "Looks");
  await diff.key({ key: "return", shift: true });
  await type(diff, "off");
  await diff.key({ key: "return" });

  expect(prompts).toEqual([]);
  expect(await diff.find({ key: "comment-cancel", in: VIEW })).toBeUndefined();
  expect(await diff.find({ type: "Text", text: "Looks\noff", in: VIEW })).toBeDefined();

  await diff.press({ key: "add-0" });
  await type(diff, "Now please");
  await diff.key({ key: "return", ctrl: true });

  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain("Now please");
  expect(prompts[0]).not.toContain("Looks");
});

test("Ctrl+Enter while Claude works rides on the next tool result, not a prompt for later", async ($, on) => {
  const { prompts } = engineBeneath(on);
  on("turn.start", (_$, e) => ({ turnId: e.turnId }));
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  on("tool.call", () => ({ result: "file.txt" }));
  const diff = await $.ui.mount(DIFF);

  await $.turn.start({ text: "do the thing", turnId: "t1" });
  await comment(diff, "add-2", "Stop, wrong file", "comment-single");
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
  await comment(diff, "add-2", "Also this", "comment-single");
  expect(prompts).toEqual([]);

  await $.turn.complete(TURN_DONE);
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain("Also this");
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
  on("turn.start", (_$, e) => ({ turnId: e.turnId }));
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  on("ui.render", { component: "PromptHint" }, () => ENGINE_HINT);
  const diff = await $.ui.mount(DIFF);

  await $.turn.start({ text: "do the thing", turnId: "t1" });
  await comment(diff, "add-2", "Test1", "comment-single");
  await diff.press({ key: "reply-2" });
  await type(diff, "Test2");
  await diff.press({ key: "comment-review" });
  await $.turn.complete(TURN_DONE);

  const footer = await $.ui.mount(FOOTER);
  expect(await footer.find({ type: "Text", text: "1 pending · 0 sent · 0 resolved" })).toBeDefined();

  isDropping = false;
  await footer.press({ key: "submit-review" });
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain("Test1\n\nTest2");
  expect(prompts[0]).not.toContain("Already sent");
});

test("an empty box adds no comment, and Cancel closes it", async ($, on) => {
  engineBeneath(on);
  const diff = await $.ui.mount(DIFF);

  await diff.press({ key: "add-0" });
  await diff.press({ key: "comment-review" });
  expect(await diff.find({ key: "comment-cancel", in: VIEW })).toBeDefined();
  expect(await diff.find({ type: "Text", text: "c1", in: VIEW })).toBeUndefined();

  await diff.press({ key: "comment-cancel" });
  expect(await diff.find({ key: "comment-cancel", in: VIEW })).toBeUndefined();

  const footer = await $.ui.mount(FOOTER);
  expect(await footer.drawn()).toMatchObject(ENGINE_HINT);
});

test("reply adds to the line's comment instead of making a new one, and the overview shows both", async ($, on) => {
  const { prompts } = engineBeneath(on);
  const diff = await $.ui.mount(DIFF);
  await comment(diff, "add-2", "Test1", "comment-single");

  await diff.press({ key: "reply-2" });
  await type(diff, "Test2");
  await diff.press({ key: "comment-review" });

  await diff.press({ key: "add-2" });
  await type(diff, "Test3");
  await diff.press({ key: "comment-review" });

  const footer = await $.ui.mount(FOOTER);
  expect(await footer.find({ key: "go-c2" })).toBeUndefined();
  expect((await footer.find({ key: "go-c1" }))?.text).toContain("Test1 · Test2 · Test3");
  expect(await footer.find({ type: "Text", text: "1 pending · 0 sent · 0 resolved" })).toBeDefined();

  await footer.press({ key: "submit-review" });
  expect(prompts[1]).toContain("[c1] /repo/src/thing.tsx:11");
  expect(prompts[1]).toContain("Already sent:\n> Test1\n\nNew:\nTest2\n\nTest3");
});

test("edit changes the comment's last message; an edit Claude has read goes out again", async ($, on) => {
  const { prompts } = engineBeneath(on);
  const diff = await $.ui.mount(DIFF);
  await comment(diff, "add-2", "Rename");

  await diff.press({ key: "edit-c1" });
  expect(await diff.find({ key: "comment-update", in: VIEW })).toBeDefined();
  expect(await diff.find({ key: "comment-single", in: VIEW })).toBeUndefined();
  expect(await diff.find({ type: "Text", text: "Rename", in: VIEW })).toBeDefined();
  await type(diff, " it");
  await diff.press({ key: "comment-update" });
  expect(await diff.find({ type: "Text", text: "Rename it", in: VIEW })).toBeDefined();

  const footer = await $.ui.mount(FOOTER);
  await footer.press({ key: "submit-review" });
  expect(prompts[0]).not.toContain("edited");

  await diff.press({ key: "edit-c1" });
  await type(diff, " to total");
  await diff.key({ key: "return" });
  expect(await footer.find({ type: "Text", text: "1 pending · 0 sent · 0 resolved" })).toBeDefined();

  await footer.press({ key: "submit-review" });
  expect(prompts[1]).toContain("[c1] /repo/src/thing.tsx:11 (edited since you read it)");
  expect(prompts[1]).toContain("Rename it to total");
});

test("Ctrl+Enter on an edit saves it and sends the comment at once", async ($, on) => {
  const { prompts } = engineBeneath(on);
  const diff = await $.ui.mount(DIFF);
  await comment(diff, "add-2", "Rename");

  await diff.press({ key: "edit-c1" });
  await type(diff, " it");
  await diff.key({ key: "return", ctrl: true });

  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain("[c1] /repo/src/thing.tsx:11");
  expect(prompts[0]).toContain("Rename it");
});

test("a reply to a resolved comment reopens it", async ($, on) => {
  engineBeneath(on);
  const diff = await $.ui.mount(DIFF);
  await comment(diff, "add-3", "Fine as is");

  const footer = await $.ui.mount(FOOTER);
  await footer.press({ key: "resolve-c1" });
  expect(await footer.find({ key: "delete-c1" })).toBeUndefined();

  await diff.press({ key: "reply-3" });
  await type(diff, "Not quite");
  await diff.press({ key: "comment-review" });

  expect(await footer.find({ type: "Text", text: "1 pending · 0 sent · 0 resolved" })).toBeDefined();
  expect(await footer.find({ key: "delete-c1" })).toBeDefined();
  expect(await diff.find({ type: "Text", text: "resolved by you", in: VIEW })).toBeUndefined();
});

test("a comment in the overview opens in a pane with its diff; the prompt adds to it until the pane closes", async ($, on) => {
  const { prompts, panes } = engineBeneath(on);
  const diff = await $.ui.mount(DIFF);
  await comment(diff, "add-2", "Test1");

  const footer = await $.ui.mount(FOOTER);
  await footer.press({ key: "go-c1" });
  expect(panes).toEqual(["diff-comment"]);

  const pane = await $.ui.mount(PANE);
  expect(await pane.findAll({ type: "Code" })).toHaveLength(4);
  expect(await pane.find({ type: "Text", text: "Test1" })).toBeDefined();
  expect(await pane.find({ type: "Text", text: "Esc closes" })).toBeDefined();

  const entered = await $.prompt.submit(typed("Test2"));
  expect(entered.drop).toBe("Added to c1");
  expect(prompts).toEqual([]);
  expect(await pane.find({ type: "Text", text: "Test2" })).toBeDefined();
  expect((await footer.find({ key: "go-c1" }))?.text).toContain("Test1 · Test2");

  await pane.press({ key: "pane-delete" });
  expect(await footer.find({ key: "go-c1" })).toBeUndefined();
  await $.prompt.submit(typed("an ordinary prompt"));
  expect(prompts).toEqual(["an ordinary prompt"]);
});

test("Submit review sends pending comments, Claude resolves them, and only unresolved ones can be deleted or edited", async ($, on) => {
  const { prompts } = engineBeneath(on);
  const diff = await $.ui.mount(DIFF);

  await comment(diff, "add-2", "Rename");
  await comment(diff, "add-1", "Why remove this?");

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
  await comment(diff, "add-3", "Fine as is");

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

  for (const [index, view] of [
    [cut, second],
    [cut - 1, String(views[0]?.props.key)],
  ] as const) {
    await diff.press({ key: `add-${index}` });

    for (const key of "At the cut") {
      await diff.key({ key, in: view });
    }

    await diff.press({ key: "comment-review" });
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
