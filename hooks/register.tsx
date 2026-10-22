import { atom, read, update } from "claude-code";
import type { EngineInterface, Register } from "claude-code";

import type {
  CommentDraft,
  DiffComment,
  DiffViewMessage,
  DiffViewProps,
  DiffViewTarget,
  LineContext,
  LineRef,
} from "../types";
import {
  countSummary,
  location,
  resolvedNote,
  resolver,
  STATUS,
} from "./comment-text";
import { attachToToolResult, flushAtTurnEnd, trackTurnStart } from "./delivery";
import { basename, changedFile, changeSummary, chunked, oneLineHunk, packed } from "./diff";
import {
  deleteComment,
  readThreads,
  resolve,
  saveMessage,
  sendNow,
  submitReview,
} from "./threads";

const DIFF_TOOLS = new Set(["Edit", "Write"]);
// The views' props count toward the 100,000 characters a tree holds; past
// that a diff is left to the engine.
const MAX_PROPS = 90_000;
const PANE = "diff-comment";
// The pane's rows besides the context lines and messages: its header, its
// footer and the margins between them.
const PANE_CHROME_ROWS = 6;
// The comment field in its border, the margin above the key hints and the hints.
const FIELD_ROWS = 5;
// The engine binds Ctrl+Enter to it by default; a Button naming it is
// pressed by that chord.
const SEND_NOW_ACTION = "chat:sendNow";
// A list row's columns besides the comment's id, text, location and its right
// side: the icon, the spaces and gaps between them, and a margin so the row
// never wraps.
const ROW_CHROME_COLUMNS = 9;
// What an open comment's buttons draw on the terminal, the gap between them included.
const ROW_BUTTONS = "[ Resolve ] [ Delete ]";

const drafting = atom({ plugin: "comment-diff", key: "draft" } as const, null);
// What the draft's field holds, for the send-now Button, which the field's own
// submit does not cover.
let draftText = "";

const oneLine = (text: string) => text.replace(/\s*\n\s*/g, " ");

const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;

async function remove($: EngineInterface, id: string) {
  await deleteComment($, id);

  const draft = await read($, drafting);

  if (draft !== null && draft.target.kind !== "new" && draft.target.id === id) {
    await $.ui.close({ id: PANE });
  }
}

const heading = (target: DiffViewTarget) =>
  target.kind === "new"
    ? "New comment"
    : `${target.kind === "reply" ? "Reply to" : "Edit"} ${target.id}`;

// The line a draft is on, and the comment it adds to or edits.
function draftLine(
  draft: CommentDraft,
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

async function compose($: EngineInterface, draft: CommentDraft) {
  const found = draftLine(draft, await readThreads($));

  if (found === undefined) {
    $.ui.toast("That comment was deleted meanwhile");
    return;
  }

  await update($, drafting, () => draft);
  draftText = draft.target.kind === "edit" ? (found.comment?.messages.at(-1) ?? "") : "";

  const opened = await $.ui.open({
    id: PANE,
    title: `${heading(draft.target)} · ${location(found.ref, basename(found.ref.filePath))}`,
    focus: true,
    closeOnEscape: true,
    rows:
      found.context.lines.length +
      (found.comment?.messages.length ?? 0) +
      FIELD_ROWS +
      PANE_CHROME_ROWS,
  });

  if (!opened.isPlaced) {
    await update($, drafting, () => null);
    $.ui.toast(`Can't open the comment box: ${opened.reason}`);
  }
}

async function saveDraft($: EngineInterface, text: string, now: boolean) {
  const draft = await read($, drafting);
  const trimmed = text.trim();

  if (draft === null || trimmed === "") {
    return;
  }

  const id = await saveMessage($, draft.toolUseId, draft.target, trimmed);
  await update($, drafting, () => null);
  await $.ui.close({ id: PANE });

  if (id !== undefined && now) {
    await sendNow($, id);
  }
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

  on("ui.message", { module: "hooks/diff-view.tsx" }, async ($, e) => {
    // The matcher admits only the diff view, which posts a DiffViewMessage.
    const { target } = e.data as DiffViewMessage;
    await compose($, { toolUseId: e.requestId, target });

    return {};
  });

  // Esc closes the pane, which drops a draft unsaved.
  on("ui.close", { id: PANE }, async ($, e, next) => {
    await update($, drafting, () => null);

    return next(e);
  });

  on("ui.render", { component: "ToolResult" }, async ($, e, next) => {
    if (e.surface !== "terminal" || e.props.isErrored || !DIFF_TOOLS.has(e.props.tool)) {
      return next(e);
    }

    const file = changedFile(e.props.output);

    if (file === undefined) {
      return next(e);
    }

    const lines = file.hunks.flat();

    if (lines.length === 0) {
      return next(e);
    }

    const all = await readThreads($);
    const comments = all
      .filter((c) => c.toolUseId === e.requestId)
      .map((c) => ({
        id: c.id,
        index: c.index,
        messages: c.messages,
        status: c.status,
        note: resolvedNote(c),
      }));
    const views = chunked(file).map(({ continuesHunk, ...chunk }) => {
      const end = chunk.first + chunk.hunks.flat().length;

      return {
        continuesHunk,
        props: {
          ...packed(chunk),
          filePath: file.filePath,
          comments: comments.filter((c) => c.index >= chunk.first && c.index < end),
        } satisfies DiffViewProps,
      };
    });

    if (JSON.stringify(views).length > MAX_PROPS) {
      return next(e);
    }

    const { Box, Client, Text } = $.ui.resolve(e);

    return (
      <Box flexDirection="column">
        <Text>
          {changeSummary(lines)}
          <Text dimColor> · + to comment</Text>
        </Text>
        {views.map(({ continuesHunk, props }) => (
          <Box flexDirection="column">
            {props.first > 0 && !continuesHunk && <Text dimColor> ...</Text>}
            <Client
              key={`diff-${e.requestId}-${props.first}`}
              module="./diff-view.tsx"
              props={props}
              width="100%"
            />
          </Box>
        ))}
      </Box>
    );
  });

  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const { Box, Button, Code, Text } = $.ui.resolve(e);
    // Mobile draws no Input; a draft is only started from the terminal's diff.
    const { Input } = e.surface === "mobile" ? { Input: undefined } : $.ui.resolve(e);
    const all = await readThreads($);
    const draft = await read($, drafting);

    const contextRows = (filePath: string, { lines, at }: LineContext) => (
      <Box flexDirection="column" marginTop={1}>
        {lines.map((line, i) => (
          <Box flexDirection="row">
            <Text color="warning">{i === at ? "›" : " "}</Text>
            <Text> </Text>
            <Box flexGrow={1} flexShrink={1}>
              <Code format="diff" path={filePath} source={oneLineHunk(line)} />
            </Box>
          </Box>
        ))}
      </Box>
    );

    const found = draft === null ? undefined : draftLine(draft, all);

    if (draft === null || found === undefined) {
      return <Text dimColor>This comment was deleted.</Text>;
    }

    const isEdit = draft.target.kind === "edit";
    const messages = found.comment?.messages ?? [];
    const earlier = isEdit ? messages.slice(0, -1) : messages;
    const last = messages.at(-1);
    const open = found.comment?.status === "resolved" ? undefined : found.comment;

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Box flexDirection="row" flexGrow={1} flexShrink={1} gap={1}>
            <Text weight="bold">{heading(draft.target)}</Text>
            <Text dimColor>{location(found.ref, basename(found.ref.filePath))}</Text>
          </Box>
          {open !== undefined && (
            <Box flexDirection="row" flexShrink={0} gap={1}>
              <Button
                key="pane-resolve"
                onPress={async () => {
                  await resolve($, new Set([open.id]), "person");
                  await $.ui.close({ id: PANE });
                }}
              >
                <Text color="success">Resolve</Text>
              </Button>
              <Button key="pane-delete" onPress={() => remove($, open.id)}>
                <Text color="error">Delete</Text>
              </Button>
            </Box>
          )}
        </Box>
        {contextRows(found.ref.filePath, found.context)}
        {earlier.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {earlier.map((message) => (
              <Text dimColor>{message}</Text>
            ))}
          </Box>
        )}
        <Box borderStyle="round" borderDimColor paddingX={1} marginTop={1}>
          {Input === undefined ? (
            <Text dimColor>Write it in the terminal</Text>
          ) : (
            // One row: from two the field adds its own "shift+⏎ new line"
            // hint, and it always draws " ⏎ <submitLabel>", so that is left
            // empty for the hints below.
            <Input
              key="comment-input"
              autoFocus
              placeholder={draft.target.kind === "reply" ? "Reply…" : "Leave a comment"}
              submitLabel=""
              {...(isEdit && last !== undefined ? { value: last } : {})}
              onInput={(text) => {
                draftText = text;
              }}
              onSubmit={(text) => saveDraft($, text, false)}
            />
          )}
        </Box>
        <Box flexDirection="row" gap={1} paddingX={1}>
          <Button key="comment-save" plain onPress={() => saveDraft($, draftText, false)}>
            <Text weight="bold">Enter</Text>{" "}
            <Text dimColor>{isEdit ? "save" : "add to review queue"}</Text>
          </Button>
          <Text dimColor>·</Text>
          <Button
            key="comment-send-now"
            plain
            action={SEND_NOW_ACTION}
            onPress={() => saveDraft($, draftText, true)}
          >
            <Text weight="bold">Ctrl+Enter</Text> <Text dimColor>send to Claude now</Text>
          </Button>
          <Text dimColor>·</Text>
          <Button key="comment-cancel" plain onPress={() => $.ui.close({ id: PANE })}>
            <Text weight="bold">Esc</Text> <Text dimColor>cancel</Text>
          </Button>
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
