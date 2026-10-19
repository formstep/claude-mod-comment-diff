import type { ClientKeyEvent, ClientModule, ClientSurface, RenderElement } from "claude-code";

import type { DiffLine, DiffViewComment, DiffViewMessage, DiffViewProps } from "../types";
import { oneLineHunk } from "./diff";

type Target = { index: number; edits?: string; extends?: string };
type View = { target: Target | null; text: string; cursor: number };

const CLOSED: View = { target: null, text: "", cursor: 0 };
const CONTEXT_LINES = 3;

const STATUS = {
  pending: { icon: "○", color: "warning" },
  sent: { icon: "◐", color: "suggestion" },
  resolved: { icon: "✓", color: "success" },
} as const;

// Named keys arrive by name; anything else is typed (or pasted) text.
const NAMED_KEYS = new Set([
  "up",
  "down",
  "left",
  "right",
  "return",
  "enter",
  "tab",
  "backspace",
  "delete",
  "pageup",
  "pagedown",
  "home",
  "end",
  "insert",
  "escape",
  ...Array.from({ length: 24 }, (_, i) => `f${i + 1}`),
]);

const insert = (view: View, typed: string): View => ({
  ...view,
  text: view.text.slice(0, view.cursor) + typed + view.text.slice(view.cursor),
  cursor: view.cursor + typed.length,
});

function edit(view: View, event: ClientKeyEvent): View {
  const { text, cursor } = view;

  if (event.ctrl) {
    switch (event.key) {
      case "a":
        return { ...view, cursor: 0 };
      case "e":
        return { ...view, cursor: text.length };
      case "u":
        return { ...view, text: text.slice(cursor), cursor: 0 };
      default:
        return view;
    }
  }

  switch (event.key) {
    case "left":
      return { ...view, cursor: Math.max(0, cursor - 1) };
    case "right":
      return { ...view, cursor: Math.min(text.length, cursor + 1) };
    case "home":
      return { ...view, cursor: 0 };
    case "end":
      return { ...view, cursor: text.length };
    case "backspace":
      return cursor === 0
        ? view
        : { ...view, text: text.slice(0, cursor - 1) + text.slice(cursor), cursor: cursor - 1 };
    case "delete":
      return { ...view, text: text.slice(0, cursor) + text.slice(cursor + 1) };
    case "return":
    case "enter":
      return event.shift || event.meta ? insert(view, "\n") : view;
    case "space":
      return insert(view, " ");
    default:
      return NAMED_KEYS.has(event.key) || event.meta ? view : insert(view, event.key);
  }
}

function locate(hunks: readonly DiffLine[][], index: number) {
  let at = index;

  for (const hunk of hunks) {
    const line = hunk[at];

    if (line !== undefined) {
      return { hunk, at, line };
    }

    at -= hunk.length;
  }

  return undefined;
}

const DiffView: ClientModule<DiffViewProps, View> = (props, surface: ClientSurface<View>) => {
  const { Box, Button, Code, Text } = surface.elements;
  const view = surface.state ?? CLOSED;
  const commentOn = (index: number) => props.comments.find((c) => c.index === index);

  const open = (target: Target, text = "") =>
    surface.setState({ target, text, cursor: text.length });

  const startAt = (index: number) => {
    const comment = commentOn(index);
    open(comment === undefined ? { index } : { index, extends: comment.id });
  };

  const send = (action: DiffViewMessage["action"]) => {
    const { target, text } = surface.state ?? CLOSED;
    const found = target === null ? undefined : locate(props.hunks, target.index);

    if (target === null || found === undefined || text.trim() === "") {
      return;
    }

    const { hunk, at, line } = found;
    const from = Math.max(0, at - CONTEXT_LINES);

    surface.post({
      action,
      filePath: props.filePath,
      index: target.index,
      line,
      context: { lines: hunk.slice(from, at + CONTEXT_LINES + 1), at: at - from },
      ...(target.edits === undefined ? {} : { edits: target.edits }),
      ...(target.extends === undefined ? {} : { extends: target.extends }),
      text,
    } satisfies DiffViewMessage);
    surface.setState(CLOSED);
  };

  surface.onKey((event) => {
    const before = surface.state ?? CLOSED;

    if (before.target === null) {
      return;
    }

    const isEnter = event.key === "return" || event.key === "enter";

    if (isEnter && event.ctrl) {
      send("single");
      return;
    }

    if (isEnter && !event.shift && !event.meta) {
      send(before.target.edits === undefined ? "review" : "update");
      return;
    }

    const after = edit(before, event);

    if (after !== before) {
      surface.setState(after);
    }
  });

  const editor = (target: Target) => {
    const rule = "─".repeat(Math.max(20, surface.columns - 2));
    const at = view.text[view.cursor];
    const caret = at === undefined || at === "\n" ? " " : at;
    const rest = view.text.slice(at === undefined || at === "\n" ? view.cursor : view.cursor + 1);
    const what = target.extends === undefined ? "your comment" : `more for ${target.extends}`;
    const placeholder = `Type ${what} · Enter: ${target.edits === undefined ? "add to review" : "save"} · Ctrl+Enter: send to Claude now`;

    return (
      <Box flexDirection="column" marginLeft={2}>
        <Text dimColor wrap="truncate-end">
          {rule}
        </Text>
        <Box flexDirection="row" gap={1}>
          <Text dimColor>›</Text>
          <Box flexGrow={1} flexShrink={1}>
            {view.text === "" ? (
              <Text>
                <Text inverse> </Text>
                <Text dimColor>{placeholder}</Text>
              </Text>
            ) : (
              <Text>
                {view.text.slice(0, view.cursor)}
                <Text inverse>{caret}</Text>
                {rest}
              </Text>
            )}
          </Box>
          <Box flexDirection="row" flexShrink={0} gap={1}>
            <Button key="comment-cancel" label="Cancel" onPress={() => surface.setState(CLOSED)} />
            {target.edits !== undefined && (
              <Button
                key="comment-update"
                variant="primary"
                label="Update comment"
                onPress={() => send("update")}
              />
            )}
            {target.edits === undefined && (
              <Button
                key="comment-single"
                label="Add single comment"
                onPress={() => send("single")}
              />
            )}
            {target.edits === undefined && (
              <Button
                key="comment-review"
                variant="primary"
                label={props.reviewLabel}
                onPress={() => send("review")}
              />
            )}
          </Box>
        </Box>
        <Text dimColor wrap="truncate-end">
          {rule}
        </Text>
      </Box>
    );
  };

  const note = (comment: DiffViewComment) => (
    <Box flexDirection="row" gap={1} paddingLeft={4}>
      <Text color={STATUS[comment.status].color}>{STATUS[comment.status].icon}</Text>
      <Text dimColor>{comment.id}</Text>
      <Box flexDirection="column" flexShrink={1}>
        {comment.messages.map((message, i) => (
          <Text dimColor={comment.status === "resolved"}>
            {message}
            <Text dimColor>{i === comment.messages.length - 1 ? comment.note : ""}</Text>
          </Text>
        ))}
      </Box>
      {comment.status !== "resolved" && (
        <Button
          key={`edit-${comment.id}`}
          plain
          dimColor
          label="edit"
          onPress={() =>
            open({ index: comment.index, edits: comment.id }, comment.messages.at(-1) ?? "")
          }
        />
      )}
    </Box>
  );

  const rows: RenderElement[] = [];
  let index = 0;

  for (const [hunkIndex, hunk] of props.hunks.entries()) {
    if (hunkIndex > 0) {
      rows.push(<Text dimColor> ...</Text>);
    }

    for (const line of hunk) {
      const here = index;
      index += 1;

      const comment = commentOn(here);
      const editing = view.target?.index === here ? view.target : null;

      rows.push(
        <Box flexDirection="row">
          <Button key={`add-${here}`} plain dimColor label="+" onPress={() => startAt(here)} />
          <Text> </Text>
          <Box flexGrow={1} flexShrink={1}>
            <Code format="diff" path={props.filePath} source={oneLineHunk(line)} />
          </Box>
        </Box>,
      );

      if (comment !== undefined) {
        rows.push(editing?.edits === comment.id ? editor(editing) : note(comment));
      }

      if (editing !== null && editing.edits === undefined) {
        rows.push(editor(editing));
      } else if (comment !== undefined) {
        rows.push(
          <Box paddingLeft={4}>
            <Button
              key={`reply-${here}`}
              plain
              dimColor
              label="reply"
              onPress={() => startAt(here)}
            />
          </Box>,
        );
      }
    }
  }

  return (
    <Box flexDirection="column">
      <Text>
        {props.summary}
        <Text dimColor> · + to comment</Text>
      </Text>
      {rows}
    </Box>
  );
};

export default DiffView;
