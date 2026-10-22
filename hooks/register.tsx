import { atom, read, update } from "claude-code";
import type { EngineInterface, Register } from "claude-code";

import type { CommentDraft, CommentTarget, DiffComment, LineContext, LineRef } from "../types";
import {
  countSummary,
  location,
  resolvedNote,
  resolver,
  STATUS,
} from "./comment-text";
import { attachToToolResult, flushAtTurnEnd, trackTurnStart } from "./delivery";
import {
  basename,
  changeCounts,
  changedFile,
  changeSummary,
  drawnText,
  oneLineHunk,
  shellChanges,
  withoutShellDiff,
} from "./diff";
import { diffRows } from "./diff-rows";
import {
  deleteComment,
  readThreads,
  resolve,
  saveMessage,
  sendNow,
  submitReview,
} from "./threads";

const DIFF_TOOLS = new Set(["Edit", "Write"]);
// A tree draws the first 100,000 characters of its texts and holds 20,000
// nodes, about four a row; past either a diff is left to the engine.
const MAX_TEXT = 90_000;
const MAX_ROWS = 4_000;
// A list row's columns besides the comment's id, text, location and its right
// side: the icon, the spaces and gaps between them, and a margin so the row
// never wraps.
const ROW_CHROME_COLUMNS = 9;
// What an open comment's buttons draw on the terminal, the gap between them included.
const ROW_BUTTONS = "[ Resolve ] [ Delete ]";

const drafting = atom({ plugin: "comment-diff", key: "draft" } as const, null);

const oneLine = (text: string) => text.replace(/\s*\n\s*/g, " ");

const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;

async function remove($: EngineInterface, id: string) {
  await deleteComment($, id);

  const draft = await read($, drafting);

  if (draft !== null && draft.target.kind !== "new" && draft.target.id === id) {
    await endDraft($);
  }
}

const heading = (target: CommentTarget) =>
  target.kind === "new"
    ? "New comment"
    : `${target.kind === "reply" ? "Reply to" : "Edit"} ${target.id}`;

// The line a draft is on, and the comment it adds to or edits.
function draftLine(
  draft: Pick<CommentDraft, "toolUseId" | "target">,
  all: readonly DiffComment[],
): { ref: LineRef; context: LineContext; comment?: DiffComment } | undefined {
  const { target } = draft;

  if (target.kind === "new") {
    const { filePath, index, line, context } = target;

    return { ref: { toolUseId: draft.toolUseId, filePath, index, line }, context };
  }

  const { id } = target;
  const comment = all.find((c) => c.id === id);

  return comment === undefined ? undefined : { ref: comment, context: comment.context, comment };
}

// Starts a comment, written in the prompt box under the box that shows its
// line. The person's own draft is set aside until the comment is saved or
// cancelled; an edit starts from the comment's last message.
async function compose($: EngineInterface, started: Pick<CommentDraft, "toolUseId" | "target">) {
  const found = draftLine(started, await readThreads($));

  if (found === undefined) {
    $.ui.toast("That comment was deleted meanwhile");
    return;
  }

  const current = await read($, drafting);
  const aside = current?.aside ?? (await $.prompt.read()).text;
  await update($, drafting, () => ({ ...started, aside }));

  if (started.target.kind === "edit") {
    await $.prompt.fill({ text: found.comment?.messages.at(-1) ?? "" });
  } else if (current === null || current.target.kind === "edit") {
    await $.prompt.fill({ text: "" });
  }
}

// Ends the comment being written and gives the prompt back the person's draft.
async function endDraft($: EngineInterface) {
  const draft = await read($, drafting);

  if (draft === null) {
    return;
  }

  await update($, drafting, () => null);
  await $.prompt.fill({ text: draft.aside });
}

// Saves `text` as the comment being written; resolves its id, or undefined
// when nothing was saved.
async function saveDraft($: EngineInterface, text: string, now: boolean) {
  const draft = await read($, drafting);
  const trimmed = text.trim();

  if (draft === null || trimmed === "") {
    return undefined;
  }

  const id = await saveMessage($, draft.toolUseId, draft.target, trimmed);
  await endDraft($);

  if (id !== undefined && now) {
    await sendNow($, id);
  }

  return id;
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    await $.tool.register({
      name: "resolve",
      description:
        'Marks review comments the person left on lines of your diffs as resolved. Call it once you have handled a comment, with the comment ids from the review message (like "c3") and a one-line note on what you did.',
      inputSchema: {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "string" }, description: 'Comment ids, like "c3"' },
          note: { type: "string", description: "What you did, in one line" },
        },
        required: ["ids"],
      },
      isDeferred: false,
    });

    // 0.3.0 wrote comments in a pane, its draft holding no set-aside prompt.
    const draft = await read($, drafting);

    if (draft !== null && typeof draft.aside !== "string") {
      await update($, drafting, () => null);
    }

    await $.ui.close({ id: "diff-comment" });

    return next(e);
  });

  // The matcher stays a literal: the engine's scan reads no imported names there.
  on("tool.call", { tool: "mcp__comment-diff__resolve" }, async ($, e) => {
    const asked = Array.isArray(e.ids)
      ? e.ids.filter((id): id is string => typeof id === "string")
      : [];
    const note = typeof e.note === "string" ? e.note.trim() : undefined;
    const wasResolved = new Set(
      (await readThreads($)).filter((c) => c.status === "resolved").map((c) => c.id),
    );
    // Judged by what the write found, so a comment deleted meanwhile counts as unknown.
    const found = new Set((await resolve($, new Set(asked), "claude", note)).map((c) => c.id));

    const unknown = asked.filter((id) => !found.has(id));
    const already = asked.filter((id) => found.has(id) && wasResolved.has(id));
    const open = asked.filter((id) => found.has(id) && !wasResolved.has(id));

    const parts = [
      open.length > 0 ? `Resolved ${open.join(", ")}.` : "Resolved nothing.",
      already.length > 0 ? `Already resolved: ${already.join(", ")}.` : "",
      unknown.length > 0
        ? `No such comment (the person may have deleted it): ${unknown.join(", ")}.`
        : "",
    ];

    return { result: parts.filter(Boolean).join(" ") };
  });

  on("turn.start", trackTurnStart);
  on("tool.call", attachToToolResult);
  on("turn.complete", flushAtTurnEnd);

  // While a comment is being written, Enter in the prompt saves it.
  on("prompt.submit", async ($, e, next) => {
    const draft = await read($, drafting);

    if (draft === null || e.origin.kind !== "composer" || e.command !== undefined) {
      return next(e);
    }

    if (e.text.trim() === "") {
      return { drop: "Type the comment first" };
    }

    const id = await saveDraft($, e.text, false);
    // Again once the engine has cleared the box of the dropped prompt.
    $.clock.after(0, () => void $.prompt.fill({ text: id === undefined ? e.text : draft.aside }));

    return { drop: id === undefined ? "That comment was deleted meanwhile" : `Comment ${id} saved` };
  });

  on("ui.render", { component: "ToolResult" }, async ($, e, next) => {
    if (e.surface !== "terminal" || e.props.isErrored) {
      return next(e);
    }

    const { tool, output } = e.props;
    const edited = DIFF_TOOLS.has(tool) ? changedFile(output) : undefined;
    const shell = tool === "Bash" ? shellChanges(output) : undefined;
    const files = edited === undefined ? (shell?.files ?? []) : [edited];
    const lines = files.flatMap((file) => file.hunks.flat());
    const comments = (await readThreads($)).filter((c) => c.toolUseId === e.requestId);
    const text = drawnText(lines) + comments.flatMap((c) => c.messages).join("").length;

    if (lines.length === 0 || text > MAX_TEXT || lines.length > MAX_ROWS) {
      return next(e);
    }

    const elements = $.ui.resolve(e);
    const { Box, Text } = elements;
    const open = (target: CommentTarget) => compose($, { toolUseId: e.requestId, target });

    if (shell === undefined) {
      return (
        <Box flexDirection="column">
          <Text>
            {changeSummary(lines)}
            <Text dimColor> · + to comment</Text>
          </Text>
          {files.flatMap((file) => diffRows(elements, file, 0, comments, open))}
        </Box>
      );
    }

    // The command's own output as the engine draws it, and under it each file
    // it changed, headed as the engine heads it.
    const ran = await next({ ...e, props: { ...e.props, output: withoutShellDiff(output) } });
    const cwd = `${await $.session.cwd()}/`;
    let first = 0;

    return (
      <Box flexDirection="column">
        {ran}
        {shell.files.map((file) => {
          const fileLines = file.hunks.flat();
          const rows = diffRows(elements, file, first, comments, open);
          first += fileLines.length;

          return (
            <Box flexDirection="column">
              <Text>
                {file.change}{" "}
                <Text weight="bold">
                  {file.filePath.startsWith(cwd) ? file.filePath.slice(cwd.length) : file.filePath}
                </Text>{" "}
                {changeCounts(fileLines)}
                <Text dimColor> · + to comment</Text>
              </Text>
              {rows}
            </Box>
          );
        })}
        {shell.moreFiles > 0 && (
          <Text dimColor>
            … {shell.moreFiles} more {shell.moreFiles === 1 ? "file" : "files"} changed
          </Text>
        )}
      </Box>
    );
  });

  // The comment being written: its line, the lines around it and the keys,
  // above the prompt it is typed in. A pane would dock beside a wide
  // transcript and narrow it, and every diff in it would be drawn again.
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const draft = await read($, drafting);
    const found = draft === null ? undefined : draftLine(draft, await readThreads($));

    if (draft === null || found === undefined || e.props.hasSurvey) {
      return next(e);
    }

    const { Box, Button, Code, Text } = $.ui.resolve(e);
    const isEdit = draft.target.kind === "edit";
    const messages = found.comment?.messages ?? [];
    const earlier = isEdit ? messages.slice(0, -1) : messages;
    const open = found.comment?.status === "resolved" ? undefined : found.comment;
    const { lines, at } = found.context;

    return (
      <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
        <Box flexDirection="row" gap={1}>
          <Box flexDirection="row" flexGrow={1} flexShrink={1} gap={1}>
            <Text weight="bold">{heading(draft.target)}</Text>
            <Text dimColor>{location(found.ref, basename(found.ref.filePath))}</Text>
          </Box>
          <Box flexDirection="row" flexShrink={0} gap={1}>
            {open !== undefined && (
              <>
                <Button
                  key="draft-resolve"
                  onPress={async () => {
                    await resolve($, new Set([open.id]), "person");
                    await endDraft($);
                  }}
                >
                  <Text color="success">Resolve</Text>
                </Button>
                <Button key="draft-delete" onPress={() => remove($, open.id)}>
                  <Text color="error">Delete</Text>
                </Button>
              </>
            )}
            {/* Ctrl+Enter cannot stand for it: the prompt submits on that chord. */}
            <Button
              key="draft-send-now"
              onPress={async () => {
                if ((await saveDraft($, (await $.prompt.read()).text, true)) === undefined) {
                  $.ui.toast("Type the comment in the prompt first");
                }
              }}
            >
              Send now
            </Button>
            <Button key="draft-cancel" onPress={() => endDraft($)}>
              Cancel
            </Button>
          </Box>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {lines.map((line, i) => (
            <Box flexDirection="row">
              <Text color="warning">{i === at ? "›" : " "}</Text>
              <Text> </Text>
              <Box flexGrow={1} flexShrink={1}>
                <Code format="diff" path={found.ref.filePath} source={oneLineHunk(line)} />
              </Box>
            </Box>
          ))}
        </Box>
        {earlier.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {earlier.map((message) => (
              <Text dimColor>{message}</Text>
            ))}
          </Box>
        )}
        <Box key="draft-keys" marginTop={1}>
          <Text>
            <Text dimColor>Type it in the prompt · </Text>
            <Text weight="bold">Enter</Text>
            <Text dimColor> {isEdit ? "save" : "add to review queue"}</Text>
          </Text>
        </Box>
      </Box>
    );
  });

  on("ui.render", { component: "PromptHint" }, async ($, e, next) => {
    const list = await readThreads($);
    const hint = await next(e);

    if (list.length === 0) {
      return hint;
    }

    const { Box, Button, Text } = $.ui.resolve(e);
    const columns = e.viewport?.columns ?? 80;
    const pending = list.filter((c) => c.status === "pending").length;
    const ordered = [
      ...list.filter((c) => c.status !== "resolved"),
      ...list.filter((c) => c.status === "resolved"),
    ];

    return (
      <Box flexDirection="column">
        {hint}
        <Box flexDirection="row" gap={1} marginTop={1}>
          <Box flexDirection="row" flexGrow={1} gap={1}>
            <Text weight="bold">Diff comments</Text>
            <Text dimColor>{countSummary(list)}</Text>
          </Box>
          {pending > 0 && (
            <Button
              key="submit-review"
              variant="primary"
              label={`Submit review (${pending})`}
              onPress={() => submitReview($)}
            />
          )}
        </Box>
        {ordered.map((comment) => {
          const isOpen = comment.status !== "resolved";
          const where = location(comment, basename(comment.filePath), "removed");
          const side = isOpen ? ROW_BUTTONS : resolver(comment);
          const room =
            columns - comment.id.length - where.length - side.length - ROW_CHROME_COLUMNS;
          const said = comment.messages.map(oneLine).join(" · ");

          return (
            <Box key={`comment-${comment.id}`} flexDirection="row" gap={1}>
              <Box flexDirection="row" flexGrow={1} flexShrink={1}>
                <Button
                  key={`go-${comment.id}`}
                  plain
                  onPress={() =>
                    compose($, {
                      toolUseId: comment.toolUseId,
                      // A resolved comment cannot be edited; a reply reopens it.
                      target: { kind: isOpen ? "edit" : "reply", id: comment.id },
                    })
                  }
                >
                  <Text color={STATUS[comment.status].color}>{STATUS[comment.status].icon}</Text>{" "}
                  <Text dimColor>{comment.id}</Text>{" "}
                  <Text dimColor={!isOpen}>{truncate(said, Math.max(12, room))}</Text>
                  {"  "}
                  <Text dimColor>{where}</Text>
                </Button>
              </Box>
              {isOpen ? (
                <Box flexDirection="row" flexShrink={0} gap={1}>
                  <Button
                    key={`resolve-${comment.id}`}
                    onPress={() => resolve($, new Set([comment.id]), "person")}
                  >
                    <Text color="success">Resolve</Text>
                  </Button>
                  <Button key={`delete-${comment.id}`} onPress={() => remove($, comment.id)}>
                    <Text color="error">Delete</Text>
                  </Button>
                </Box>
              ) : (
                <Text dimColor>{side}</Text>
              )}
            </Box>
          );
        })}
      </Box>
    );
  });
};
