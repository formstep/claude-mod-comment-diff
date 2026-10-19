import type { ClientKeyEvent, ClientModule, ClientSurface, RenderElement } from "claude-code";

import type {
  DiffLine,
  DiffViewComment,
  DiffViewMessage,
  DiffViewProps,
  DiffViewTarget,
} from "../types";
import { STATUS } from "./comment-text";
import { basename, CONTEXT_LINES, oneLineHunk } from "./diff";

// The line whose box is open: a new comment, a reply, or an edit of a comment.
type Target = { index: number } & ({ kind: "new" } | { kind: "reply" | "edit"; id: string });
type View = { target: Target | null; text: string; cursor: number };

const CLOSED: View = { target: null, text: "", cursor: 0 };

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

// The line at `index` with the lines of its hunk around it, the ones a
// neighbouring view draws included.
function locate(props: DiffViewProps, index: number) {
  let at = index - props.first;

  for (const [i, hunk] of props.hunks.entries()) {
    const line = hunk[at];

    if (line !== undefined) {
      const lead = i === 0 ? props.lead : [];
      const tail = i === props.hunks.length - 1 ? props.tail : [];

      return { hunk: [...lead, ...hunk, ...tail], at: at + lead.length, line };
    }

    at -= hunk.length;
  }

  return undefined;
}

// What the host needs to save the message: a new comment carries its line and
// the lines around it in its hunk.
function postedTarget(props: DiffViewProps, target: Target): DiffViewTarget | undefined {
  if (target.kind !== "new") {
    return { kind: target.kind, id: target.id };
  }

  const found = locate(props, target.index);

  if (found === undefined) {
    return undefined;
  }

  const { hunk, at, line } = found;
  const from = Math.max(0, at - CONTEXT_LINES);

  return {
    kind: "new",
    filePath: props.filePath,
    index: target.index,
    line,
    context: { lines: hunk.slice(from, at + CONTEXT_LINES + 1), at: at - from },
  };
}

const DiffView: ClientModule<DiffViewProps, View> = (props, surface: ClientSurface<View>) => {
  const { Box, Button, Code, Text } = surface.elements;
  // The language is read off the name; a short path keeps every row small.
  const path = basename(props.filePath);
  const current = () => surface.state ?? CLOSED;
  const view = current();
  const commentOn = (index: number) => props.comments.find((c) => c.index === index);

  const open = (target: Target, text = "") =>
    surface.setState({ target, text, cursor: text.length });

  const startAt = (index: number) => {
    const comment = commentOn(index);
    open(comment === undefined ? { index, kind: "new" } : { index, kind: "reply", id: comment.id });
  };

  const send = (sendNow: boolean) => {
    const { target, text } = current();
    const posted = target === null ? undefined : postedTarget(props, target);

    if (posted === undefined || text.trim() === "") {
      return;
    }

    surface.post({ target: posted, text, sendNow } satisfies DiffViewMessage);
    surface.setState(CLOSED);
  };

  surface.onKey((event) => {
    const before = current();

    if (before.target === null) {
      return;
    }

    const isEnter = event.key === "return" || event.key === "enter";

    if (isEnter && event.ctrl) {
      send(true);
      return;
    }

    if (isEnter && !event.shift && !event.meta) {
      send(false);
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
    const what = target.kind === "reply" ? `more for ${target.id}` : "your comment";
    const placeholder = `Type ${what} · Enter: ${target.kind === "edit" ? "save" : "add to review"} · Ctrl+Enter: send to Claude now`;

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
            {target.kind === "edit" ? (
              <Button
                key="comment-update"
                variant="primary"
                label="Update comment"
                onPress={() => send(false)}
              />
            ) : (
              <>
                <Button
                  key="comment-single"
                  label="Add single comment"
                  onPress={() => send(true)}
                />
                <Button
                  key="comment-review"
                  variant="primary"
                  label={props.reviewLabel}
                  onPress={() => send(false)}
                />
              </>
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
            open(
              { index: comment.index, kind: "edit", id: comment.id },
              comment.messages.at(-1) ?? "",
            )
          }
        />
      )}
    </Box>
  );

  // Rows make up most of the tree, which the engine bounds at 100,000
  // serialized characters, so each holds only the elements it needs.
  const rows: RenderElement[] = [];
  let index = props.first;

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
        <Box flexDirection="row" gap={1}>
          <Button key={`add-${here}`} plain dimColor label="+" onPress={() => startAt(here)} />
          <Box flexGrow={1} flexShrink={1}>
            <Code format="diff" path={path} source={oneLineHunk(line)} />
          </Box>
        </Box>,
      );

      if (comment !== undefined) {
        rows.push(editing?.kind === "edit" ? editor(editing) : note(comment));
      }

      if (editing !== null && editing.kind !== "edit") {
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

  return <Box flexDirection="column">{rows}</Box>;
};

export default DiffView;
