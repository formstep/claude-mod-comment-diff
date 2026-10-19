import { atom, read, update } from "claude-code";
import type { EngineInterface, Register } from "claude-code";

import type { DiffComment, DiffViewMessage, DiffViewProps } from "../types";
import {
  countSummary,
  location,
  resolvedNote,
  resolver,
  reviewLabel,
  STATUS,
} from "./comment-text";
import { attachToToolResult, flushAtTurnEnd, trackTurnStart } from "./delivery";
import { basename, changedFile, changeSummary, chunked, oneLineHunk } from "./diff";
import {
  deleteComment,
  extendComment,
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
// A list row's columns besides the comment's id, text, location and its right
// side: the icon, the spaces and gaps between them, and a margin so the row
// never wraps.
const ROW_CHROME_COLUMNS = 9;
// What an open comment's buttons draw on the terminal, the gap between them included.
const ROW_BUTTONS = "[ Resolve ] [ Delete ]";

// The comment open in the pane, if any.
const viewing = atom({ plugin: "diff-comments", key: "viewing" } as const, null);

const oneLine = (text: string) => text.replace(/\s*\n\s*/g, " ");

const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;

async function remove($: EngineInterface, id: string) {
  await deleteComment($, id);

  if ((await read($, viewing)) === id) {
    await $.ui.close({ id: PANE });
  }
}

async function view($: EngineInterface, comment: DiffComment) {
  await update($, viewing, () => comment.id);

  const opened = await $.ui.open({
    id: PANE,
    title: `${comment.id} · ${location(comment, basename(comment.filePath))}`,
    focus: true,
    closeOnEscape: true,
    rows: comment.context.lines.length + comment.messages.length + PANE_CHROME_ROWS,
  });

  if (!opened.isPlaced) {
    await update($, viewing, () => null);
    $.ui.toast(`Can't open ${comment.id}: ${opened.reason}`);
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
  on("tool.call", { tool: "mcp__diff-comments__resolve" }, async ($, e) => {
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
    const message = e.data as DiffViewMessage;
    const text = message.text.trim();

    if (text === "") {
      return {};
    }

    const id = await saveMessage($, e.requestId, message.target, text);

    if (id !== undefined && message.sendNow) {
      await sendNow($, id);
    }

    return {};
  });

  // While a comment is open in its pane, the prompt box adds to it.
  on("prompt.submit", async ($, e, next) => {
    const id = await read($, viewing);
    const text = e.text.trim();

    if (id === null || e.origin.kind !== "composer" || e.command !== undefined || text === "") {
      return next(e);
    }

    if ((await extendComment($, id, text)) === undefined) {
      return next(e);
    }

    // Cleared in case the engine hands a dropped prompt back to the box.
    $.clock.after(0, () => void $.prompt.fill({ text: "" }));

    return { drop: `Added to ${id}` };
  });

  on("ui.close", { id: PANE }, async ($, e, next) => {
    await update($, viewing, () => null);

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
    const views = chunked(file).map(({ continuesHunk, ...chunk }) => ({
      continuesHunk,
      props: {
        ...chunk,
        filePath: file.filePath,
        comments,
        reviewLabel: reviewLabel(all),
      } satisfies DiffViewProps,
    }));

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
    const id = await read($, viewing);
    const comment = (await readThreads($)).find((c) => c.id === id);

    if (comment === undefined) {
      return <Text dimColor>This comment was deleted.</Text>;
    }

    const isOpen = comment.status !== "resolved";

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text color={STATUS[comment.status].color}>{STATUS[comment.status].icon}</Text>
          <Text weight="bold">{comment.id}</Text>
          <Text dimColor>
            {location(comment, basename(comment.filePath))}
            {resolvedNote(comment)}
          </Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {comment.context.lines.map((line, i) => (
            <Box flexDirection="row">
              <Text color="warning">{i === comment.context.at ? "›" : " "}</Text>
              <Text> </Text>
              <Box flexGrow={1} flexShrink={1}>
                <Code format="diff" path={comment.filePath} source={oneLineHunk(line)} />
              </Box>
            </Box>
          ))}
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {comment.messages.map((message, i) => (
            <Text>
              {message}
              <Text dimColor>{i < comment.sent ? "" : " · not sent yet"}</Text>
            </Text>
          ))}
        </Box>
        <Box flexDirection="row" gap={1} marginTop={1}>
          <Box flexGrow={1} flexShrink={1}>
            <Text dimColor>
              {isOpen ? "Type in the prompt to add to it" : "Type in the prompt to reopen it"} · Esc
              closes
            </Text>
          </Box>
          {isOpen && (
            <>
              <Button
                key="pane-resolve"
                onPress={() => resolve($, new Set([comment.id]), "person")}
              >
                <Text color="success">Resolve</Text>
              </Button>
              <Button key="pane-delete" onPress={() => remove($, comment.id)}>
                <Text color="error">Delete</Text>
              </Button>
            </>
          )}
        </Box>
      </Box>
    );
  });

  on("ui.render", { component: "PromptHint" }, async ($, e, next) => {
    const list = await readThreads($);
    const viewed = await read($, viewing);
    const hint = await next(
      viewed === null
        ? e
        : { ...e, props: { ...e.props, tail: `· Enter adds to ${viewed} · Esc closes it` } },
    );

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
                <Button key={`go-${comment.id}`} plain onPress={() => view($, comment)}>
                  <Text color={STATUS[comment.status].color}>{STATUS[comment.status].icon}</Text>{" "}
                  <Text dimColor>{comment.id}</Text>{" "}
                  <Text dimColor={!isOpen}>{truncate(said, Math.max(12, room))}</Text>
                  {"  "}
                  <Text dimColor>{where}</Text>
                </Button>
              </Box>
              {isOpen ? (
                <>
                  <Button
                    key={`resolve-${comment.id}`}
                    onPress={() => resolve($, new Set([comment.id]), "person")}
                  >
                    <Text color="success">Resolve</Text>
                  </Button>
                  <Button key={`delete-${comment.id}`} onPress={() => remove($, comment.id)}>
                    <Text color="error">Delete</Text>
                  </Button>
                </>
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
