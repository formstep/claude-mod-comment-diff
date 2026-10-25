import type { On, RenderElement } from "claude-code";
import { expect, mock, test } from "claude-code/testing";
import type { Engine, MockSession, Mounted } from "claude-code/testing";

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

const BAND = {
  plugin: PLUGIN,
  surface: "terminal",
  component: "AbovePrompt",
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 19 },
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
const ENGINE_BAND: RenderElement = { type: "Text", props: {}, children: ["engine band"] };

type Diff = Mounted<"terminal", "ToolResult">;

// The prompt box as the person left it: what they typed, or what a fill put
// there. Each test's engine starts it empty.
const box = { text: "" };

// The texts of the rows the person does not see, oldest first.
const hiddenRows = (session: MockSession) =>
  session
    .appended()
    .map((row) => row.message.content.map((b) => (typeof b.text === "string" ? b.text : "")).join(""));

// Stands in for the engine: the prompt box, the prompts that start Claude's
// turn, the reviews that go in beside them, the clock, and what the hint and
// the band draw on their own.
function engineBeneath(on: On) {
  const prompts: string[] = [];
  const session = mock.session(on);
  const clock = mock.clock(on);
  box.text = "";

  on("prompt.read", () => ({ value: { text: box.text, cursor: box.text.length } }));
  on("prompt.fill", (_$, e) => {
    box.text = e.text;
    return { isFilled: true };
  });
  on("prompt.submit", (_$, e) => {
    prompts.push(e.text);
    return { text: e.text };
  });
  on("ui.close", () => ({ value: undefined }));
  on("ui.render", { component: "PromptHint" }, () => ENGINE_HINT);
  on("ui.render", { component: "AbovePrompt" }, () => ENGINE_BAND);

  return { prompts, reviews: () => hiddenRows(session), clock };
}

const typed = (text: string) => ({ text, origin: { kind: "composer" }, wait: false }) as const;

type Send = "enter" | "now";

// The person types `text` in the prompt, then presses Enter or the box's Send now.
async function write($: Engine, text: string, send: Send = "enter") {
  if (send === "enter") {
    await $.prompt.submit(typed(text));
    return;
  }

  box.text = text;
  const band = await $.ui.mount(BAND);
  await band.press({ key: "draft-send-now" });
  await band.unmount();
}

// Presses a +, reply or edit in the diff and writes `body` for it.
async function comment($: Engine, diff: Diff, button: string, body: string, send: Send = "enter") {
  await diff.press({ key: button });
  await write($, body, send);
}

test("+ starts a comment in the prompt under a box showing its line, and Enter adds it as pending", async ($, on) => {
  const { prompts } = engineBeneath(on);
  const diff = await $.ui.mount(DIFF);
  expect(await diff.findAll({ type: "Code" })).toHaveLength(4);

  box.text = "half a prompt";
  await diff.press({ key: "add-2" });
  expect(box.text).toBe("");

  const band = await $.ui.mount(BAND);
  expect(await band.find({ type: "Text", text: "New comment" })).toBeDefined();
  expect(await band.find({ type: "Text", text: "thing.tsx:11" })).toBeDefined();
  expect(await band.findAll({ type: "Code" })).toHaveLength(4);
  expect((await band.find({ key: "draft-keys" }))?.text).toBe(
    "Type it in the prompt · Enter add to review queue",
  );
  expect(await band.find({ key: "draft-send-now" })).toBeDefined();

  const entered = await $.prompt.submit(typed("Name this better"));
  expect(entered.drop).toBe("Comment c1 saved");
  expect(prompts).toEqual([]);
  expect(box.text).toBe("half a prompt");
  expect(await band.drawn()).toMatchObject(ENGINE_BAND);
  expect(await diff.find({ type: "Text", text: "c1" })).toBeDefined();
  expect(await diff.find({ type: "Text", text: "Name this better" })).toBeDefined();

  const footer = await $.ui.mount(FOOTER);
  expect((await footer.find({ key: "go-c1" }))?.text).toContain("thing.tsx:11");
  expect((await footer.find({ key: "submit-review" }))?.props.label).toBe("Submit review (1)");
});

test("Send now sends the comment to Claude at once, its lines kept", async ($, on) => {
  const { prompts, reviews } = engineBeneath(on);
  const diff = await $.ui.mount(DIFF);

  await comment($, diff, "add-2", "Use a\nlookup", "now");

  expect(prompts).toEqual(["Handle review comment c1."]);
  expect(reviews()).toHaveLength(1);
  expect(reviews()[0]).toContain("[c1] /repo/src/thing.tsx:11");
  expect(reviews()[0]).toContain("Use a\nlookup");
  expect(box.text).toBe("");

  const footer = await $.ui.mount(FOOTER);
  expect(await footer.find({ type: "Text", text: "0 pending · 1 sent · 0 resolved" })).toBeDefined();
  expect(await footer.find({ key: "submit-review" })).toBeUndefined();
});

test("Send now while Claude works rides on the next tool result, not a prompt for later", async ($, on) => {
  const { prompts } = engineBeneath(on);
  on("turn.start", (_$, e) => ({ turnId: e.turnId }));
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  on("tool.call", () => ({ result: "file.txt" }));
  const diff = await $.ui.mount(DIFF);

  await $.turn.start({ text: "do the thing", turnId: "t1" });
  await comment($, diff, "add-2", "Stop, wrong file", "now");
  expect(prompts).toEqual([]);

  const toolResult = await $.tool.call({ tool: "Bash", command: "ls" });
  expect(toolResult.context?.join("\n")).toContain("Stop, wrong file");

  const later = await $.tool.call({ tool: "Bash", command: "ls" });
  expect(later.context).toBeUndefined();

  await $.turn.complete(TURN_DONE);
  expect(prompts).toEqual([]);
});

test("Send now while Claude works is sent as a prompt when the turn ends without a tool call", async ($, on) => {
  const { prompts, reviews, clock } = engineBeneath(on);
  on("turn.start", (_$, e) => ({ turnId: e.turnId }));
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  const diff = await $.ui.mount(DIFF);

  await $.turn.start({ text: "do the thing", turnId: "t1" });
  await comment($, diff, "add-2", "Also this", "now");
  expect(prompts).toEqual([]);

  await $.turn.complete(TURN_DONE);
  await clock.settle();
  expect(prompts).toEqual(["Handle review comment c1."]);
  expect(reviews()[0]).toContain("Also this");
});

test("a review submitted while Claude works waits for the turn to end", async ($, on) => {
  const { prompts, reviews, clock } = engineBeneath(on);
  on("turn.start", (_$, e) => ({ turnId: e.turnId }));
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  on("tool.call", () => ({ result: "file.txt" }));
  const diff = await $.ui.mount(DIFF);

  await $.turn.start({ text: "do the thing", turnId: "t1" });
  await comment($, diff, "add-2", "Rename");
  const footer = await $.ui.mount(FOOTER);
  await footer.press({ key: "submit-review" });

  const toolResult = await $.tool.call({ tool: "Bash", command: "ls" });
  expect(toolResult.context).toBeUndefined();
  expect(prompts).toEqual([]);
  expect(reviews()).toEqual([]);

  await $.turn.complete(TURN_DONE);
  await clock.settle();
  expect(prompts).toEqual(["Handle review comment c1."]);
  expect(reviews()[0]).toContain("Rename");
});

test("a blank comment adds nothing and keeps the box; Cancel gives the prompt back", async ($, on) => {
  const { prompts } = engineBeneath(on);
  on("ui.toast", () => ({ value: undefined }));
  const diff = await $.ui.mount(DIFF);

  box.text = "mine";
  await diff.press({ key: "add-0" });
  expect((await $.prompt.submit(typed("   "))).drop).toBe("Type the comment first");
  await write($, "   ", "now");

  const band = await $.ui.mount(BAND);
  expect(await band.find({ key: "draft-cancel" })).toBeDefined();
  await band.press({ key: "draft-cancel" });
  expect(await band.drawn()).toMatchObject(ENGINE_BAND);
  expect(box.text).toBe("mine");
  expect(prompts).toEqual([]);

  const footer = await $.ui.mount(FOOTER);
  expect(await footer.drawn()).toMatchObject(ENGINE_HINT);
});

test("pressing the + or edit of the comment being written again cancels it", async ($, on) => {
  const { prompts } = engineBeneath(on);
  const diff = await $.ui.mount(DIFF);
  const band = await $.ui.mount(BAND);

  box.text = "mine";
  await diff.press({ key: "add-2" });
  await diff.press({ key: "add-2" });
  expect(await band.drawn()).toMatchObject(ENGINE_BAND);
  expect(box.text).toBe("mine");

  // Another line's + moves the comment there instead.
  await diff.press({ key: "add-2" });
  await diff.press({ key: "add-3" });
  expect(await band.find({ type: "Text", text: "thing.tsx:12" })).toBeDefined();
  await write($, "Test1");

  await diff.press({ key: "edit-c1" });
  expect(box.text).toBe("Test1");
  await diff.press({ key: "edit-c1" });
  expect(await band.drawn()).toMatchObject(ENGINE_BAND);
  expect(box.text).toBe("mine");
  expect(prompts).toEqual([]);
});

test("a send that never arrives leaves the comment pending and unread, a reply made meanwhile included", async ($, on) => {
  const prompts: string[] = [];
  const session = mock.session(on);
  let isDropping = true;
  on("prompt.submit", (_$, e) => {
    if (isDropping) {
      return { drop: "Claude is busy" };
    }

    prompts.push(e.text);
    return { text: e.text };
  });
  on("prompt.read", () => ({ value: { text: "", cursor: 0 } }));
  on("prompt.fill", () => ({ isFilled: true }));
  on("clock.after", () => ({ value: undefined }));
  on("ui.render", { component: "PromptHint" }, () => ENGINE_HINT);
  const diff = await $.ui.mount(DIFF);

  await comment($, diff, "add-2", "Test1");
  const footer = await $.ui.mount(FOOTER);
  await footer.press({ key: "submit-review" });
  await comment($, diff, "reply-2", "Test2");
  expect(await footer.find({ type: "Text", text: "1 pending · 0 sent · 0 resolved" })).toBeDefined();

  isDropping = false;
  await footer.press({ key: "submit-review" });
  expect(prompts).toEqual(["Handle review comment c1."]);
  expect(hiddenRows(session).at(-1)).toContain("Test1\n\nTest2");
  expect(hiddenRows(session).at(-1)).not.toContain("Already sent");
});

test("reply adds to the line's comment instead of making a new one, and the overview shows both", async ($, on) => {
  const { reviews } = engineBeneath(on);
  const diff = await $.ui.mount(DIFF);
  await comment($, diff, "add-2", "Test1");
  const footer = await $.ui.mount(FOOTER);
  await footer.press({ key: "submit-review" });

  await diff.press({ key: "reply-2" });
  const band = await $.ui.mount(BAND);
  expect(await band.find({ type: "Text", text: "Reply to c1" })).toBeDefined();
  expect(await band.find({ type: "Text", text: "Test1" })).toBeDefined();
  await write($, "Test2");

  await comment($, diff, "add-2", "Test3");

  expect(await footer.find({ key: "go-c2" })).toBeUndefined();
  expect((await footer.find({ key: "go-c1" }))?.text).toContain("Test1 · Test2 · Test3");
  expect(await footer.find({ type: "Text", text: "1 pending · 0 sent · 0 resolved" })).toBeDefined();

  await footer.press({ key: "submit-review" });
  expect(reviews()[1]).toContain("[c1] /repo/src/thing.tsx:11");
  expect(reviews()[1]).toContain("Already sent:\n> Test1\n\nNew:\nTest2\n\nTest3");
});

test("edit puts the comment's last message in the prompt; an edit Claude has read goes out again", async ($, on) => {
  const { reviews } = engineBeneath(on);
  const diff = await $.ui.mount(DIFF);
  await comment($, diff, "add-2", "Rename");

  await diff.press({ key: "edit-c1" });
  expect(box.text).toBe("Rename");
  const band = await $.ui.mount(BAND);
  expect(await band.find({ type: "Text", text: "Edit c1" })).toBeDefined();
  expect((await band.find({ key: "draft-keys" }))?.text).toBe("Type it in the prompt · Enter save");
  await write($, "Rename it");
  expect(await diff.find({ type: "Text", text: "Rename it" })).toBeDefined();

  const footer = await $.ui.mount(FOOTER);
  await footer.press({ key: "submit-review" });
  expect(reviews()[0]).not.toContain("edited");

  await comment($, diff, "edit-c1", "Rename it to total");
  expect(await footer.find({ type: "Text", text: "1 pending · 0 sent · 0 resolved" })).toBeDefined();

  await footer.press({ key: "submit-review" });
  expect(reviews()[1]).toContain("[c1] /repo/src/thing.tsx:11 (edited since you read it)");
  expect(reviews()[1]).toContain("Rename it to total");
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
  expect(await diff.find({ type: "Text", text: "resolved by you" })).toBeUndefined();
});

test("a comment in the overview starts an edit of it, and a prompt after that reaches Claude", async ($, on) => {
  const { prompts } = engineBeneath(on);
  const diff = await $.ui.mount(DIFF);
  await comment($, diff, "add-2", "Test1");

  const footer = await $.ui.mount(FOOTER);
  await footer.press({ key: "go-c1" });
  expect(box.text).toBe("Test1");

  const band = await $.ui.mount(BAND);
  expect(await band.findAll({ type: "Code" })).toHaveLength(4);
  expect(await band.find({ key: "draft-resolve" })).toBeDefined();
  expect(await band.find({ key: "draft-delete" })).toBeDefined();

  await write($, "Test1 rewritten");
  expect((await footer.find({ key: "go-c1" }))?.text).toContain("Test1 rewritten");
  expect(await footer.find({ type: "Text", text: "1 pending · 0 sent · 0 resolved" })).toBeDefined();

  const entered = await $.prompt.submit(typed("an ordinary prompt"));
  expect(entered.drop).toBeUndefined();
  expect(prompts).toEqual(["an ordinary prompt"]);
});

test("Resolve and Delete in the box act on the comment and end it", async ($, on) => {
  engineBeneath(on);
  const diff = await $.ui.mount(DIFF);
  await comment($, diff, "add-2", "Test1");
  await comment($, diff, "add-3", "Test2");
  const footer = await $.ui.mount(FOOTER);
  const band = await $.ui.mount(BAND);

  await footer.press({ key: "go-c1" });
  await band.press({ key: "draft-resolve" });
  expect(await band.drawn()).toMatchObject(ENGINE_BAND);
  expect(box.text).toBe("");
  expect(await footer.find({ type: "Text", text: "1 pending · 0 sent · 1 resolved" })).toBeDefined();

  // A resolved comment cannot be edited, so it starts a reply, which reopens it.
  await footer.press({ key: "go-c1" });
  expect(await band.find({ type: "Text", text: "Reply to c1" })).toBeDefined();
  expect(await band.find({ key: "draft-resolve" })).toBeUndefined();
  await band.press({ key: "draft-cancel" });

  await footer.press({ key: "go-c2" });
  await band.press({ key: "draft-delete" });
  expect(await band.drawn()).toMatchObject(ENGINE_BAND);
  expect(await footer.find({ key: "go-c2" })).toBeUndefined();
});

test("deleting a comment ends the reply or edit of it, and no other", async ($, on) => {
  engineBeneath(on);
  const diff = await $.ui.mount(DIFF);
  await comment($, diff, "add-2", "Test1");
  await comment($, diff, "add-3", "Test2");
  const footer = await $.ui.mount(FOOTER);
  const band = await $.ui.mount(BAND);

  box.text = "mine";
  await diff.press({ key: "reply-2" });
  await footer.press({ key: "delete-c2" });
  expect(await band.find({ type: "Text", text: "Reply to c1" })).toBeDefined();
  await footer.press({ key: "delete-c1" });
  expect(await band.drawn()).toMatchObject(ENGINE_BAND);
  expect(box.text).toBe("mine");

  await comment($, diff, "add-3", "Test3");
  await diff.press({ key: "edit-c3" });
  await footer.press({ key: "delete-c3" });
  expect(await band.drawn()).toMatchObject(ENGINE_BAND);
});

test("Submit review sends pending comments, Claude resolves them, and only unresolved ones can be deleted or edited", async ($, on) => {
  const { prompts, reviews } = engineBeneath(on);
  const diff = await $.ui.mount(DIFF);

  await comment($, diff, "add-2", "Rename");
  await comment($, diff, "add-1", "Why remove this?");

  const footer = await $.ui.mount(FOOTER);
  await footer.press({ key: "submit-review" });

  expect(prompts).toEqual(["Handle review comments c1, c2."]);
  expect(reviews()).toHaveLength(1);
  expect(reviews()[0]).toContain("[c1] /repo/src/thing.tsx:11");
  expect(reviews()[0]).toContain("[c2] /repo/src/thing.tsx:11 (removed line)");
  expect(reviews()[0]).toContain("mcp__comment-diff__resolve");
  expect(await footer.find({ type: "Text", text: "0 pending · 2 sent · 0 resolved" })).toBeDefined();

  const answer = await $.tool.call({
    tool: "mcp__comment-diff__resolve",
    ids: ["c1", "c9"],
    note: "Renamed it",
  });
  expect(answer.result).toBe("Resolved c1. No such comment (the person may have deleted it): c9.");

  expect(await footer.find({ key: "delete-c1" })).toBeUndefined();
  expect(await diff.find({ key: "edit-c1" })).toBeUndefined();
  expect(await diff.find({ type: "Text", text: "resolved by Claude: Renamed it" })).toBeDefined();

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
  expect(await diff.find({ type: "Text", text: "resolved by you" })).toBeDefined();
});

test("a resolved comment leaves the list a minute later and stays under its line in the diff", async ($, on) => {
  const { clock } = engineBeneath(on);
  const diff = await $.ui.mount(DIFF);
  await comment($, diff, "add-1", "Keep this");
  await comment($, diff, "add-3", "Fine as is");

  const footer = await $.ui.mount(FOOTER);
  await footer.press({ key: "resolve-c2" });
  await clock.advance(59_999);
  expect(await footer.find({ key: "go-c2" })).toBeDefined();

  await clock.advance(1);
  expect(await footer.find({ key: "go-c2" })).toBeUndefined();
  expect(await footer.find({ type: "Text", text: "1 pending · 0 sent · 0 resolved" })).toBeDefined();
  expect(await diff.find({ type: "Text", text: "resolved by you" })).toBeDefined();

  await $.tool.call({ tool: "mcp__comment-diff__resolve", ids: ["c1"], note: "Kept it" });
  await clock.advance(60_000);
  expect(await footer.drawn()).toMatchObject(ENGINE_HINT);
});

test("a comment reopened before its minute is up stays in the list", async ($, on) => {
  const { clock } = engineBeneath(on);
  const diff = await $.ui.mount(DIFF);
  await comment($, diff, "add-3", "Fine as is");

  const footer = await $.ui.mount(FOOTER);
  await footer.press({ key: "resolve-c1" });
  await clock.advance(30_000);
  await comment($, diff, "reply-3", "Not quite");
  await clock.advance(30_000);
  expect(await footer.find({ key: "go-c1" })).toBeDefined();

  await footer.press({ key: "resolve-c1" });
  await clock.advance(60_000);
  expect(await footer.find({ key: "go-c1" })).toBeUndefined();
});

const written =(requestId: string, filePath: string, lines: number, line: (i: number) => string) =>
  ({
    ...DIFF,
    requestId,
    props: {
      tool_use_id: requestId,
      tool: "Write",
      isErrored: false,
      output: {
        type: "create",
        filePath,
        content: Array.from({ length: lines }, (_, i) => `${line(i)}\n`).join(""),
        structuredPatch: [],
        originalFile: null,
      },
    },
  }) as const;

const LONG_WRITE = written(
  "toolu_long",
  `/repo/${"nested/".repeat(12)}long.ts`,
  600,
  (i) => `export const value${i} = "line ${i}";`,
);

const wideLine = (i: number) =>
  `export const value${i} = "a longer string literal that fills line ${i}";`;

// Close to the 100,000 characters of text a tree draws.
const WIDE_WRITE = written("toolu_wide", "/repo/wide.ts", 900, wideLine);

// The + buttons of the diff.
async function pluses(diff: Diff) {
  const buttons = await diff.findAll({ type: "Button" });

  return buttons.filter((b) => String(b.props.key).startsWith("add-")).length;
}

test("a long diff keeps a + on every line, and a comment keeps the lines around it", async ($, on) => {
  engineBeneath(on);
  const diff = await $.ui.mount(LONG_WRITE);
  expect(await pluses(diff)).toBe(600);

  await comment($, diff, "add-300", "Mid file");
  const footer = await $.ui.mount(FOOTER);
  await footer.press({ key: "go-c1" });
  const band = await $.ui.mount(BAND);
  expect(await band.findAll({ type: "Code" })).toHaveLength(7);
});

test("a diff close to the text a tree draws still gets a + on every line", async ($, on) => {
  engineBeneath(on);
  const diff = await $.ui.mount(WIDE_WRITE);

  expect(await pluses(diff)).toBe(900);
});

// A shell command that changed two files, and one more than the engine diffed.
const SHELL = {
  ...DIFF,
  requestId: "toolu_sh",
  props: {
    tool_use_id: "toolu_sh",
    tool: "Bash",
    isErrored: false,
    output: {
      stdout: "applied",
      stderr: "",
      interrupted: false,
      bashEditDiff: {
        files: [
          { filePath: "/repo/src/thing.tsx", hunks: EDIT_OUTPUT.structuredPatch },
          {
            filePath: "/repo/src/fresh.ts",
            hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ["+one", "+two"] }],
            created: true,
          },
        ],
        moreFiles: 1,
      },
    },
  },
} as const;

test("a shell command's diff keeps the engine's output above it and a + on every line of every file", async ($, on) => {
  engineBeneath(on);
  on("session.cwd", () => ({ value: "/repo" }));
  const outputs: unknown[] = [];
  on("ui.render", { component: "ToolResult" }, (_$, e) => {
    outputs.push(e.props.output);
    return { type: "Text", props: {}, children: ["applied"] };
  });

  const diff = await $.ui.mount(SHELL);
  expect(outputs.at(-1)).toEqual({ stdout: "applied", stderr: "", interrupted: false });
  expect(await diff.find({ type: "Text", text: "applied" })).toBeDefined();
  expect(await diff.find({ type: "Text", text: "src/thing.tsx" })).toBeDefined();
  expect(await diff.find({ type: "Text", text: "src/fresh.ts" })).toBeDefined();
  expect(await diff.find({ type: "Text", text: "… 1 more file changed" })).toBeDefined();
  expect(await pluses(diff)).toBe(6);

  // Lines are numbered across the files: the created file's first line is 4.
  await diff.press({ key: "add-4" });
  const band = await $.ui.mount(BAND);
  expect(await band.find({ type: "Text", text: "fresh.ts:1" })).toBeDefined();
  await write($, "Name it");
  const footer = await $.ui.mount(FOOTER);
  expect((await footer.find({ key: "go-c1" }))?.text).toContain("fresh.ts:1");
  expect(await diff.find({ type: "Text", text: "Name it" })).toBeDefined();
});

test("errored calls, other tools and diffs past a tree's text keep the engine's own drawing", async ($, on) => {
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

  const huge = await $.ui.mount(written("toolu_huge", "/repo/huge.ts", 1200, wideLine));
  expect(await huge.drawn()).toMatchObject(engineDrawn);
});
