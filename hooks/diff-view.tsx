import type { ClientModule, ClientSurface, RenderElement } from "claude-code";

import type { DiffViewComment, DiffViewMessage, DiffViewProps, DiffViewTarget } from "../types";
import { STATUS } from "./comment-text";
import { basename, CONTEXT_LINES, oneLineHunk } from "./diff";

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

// What the host needs to save a new comment: its line and the lines around it
// in its hunk.
function newTarget(props: DiffViewProps, index: number): DiffViewTarget | undefined {
  const found = locate(props, index);

  if (found === undefined) {
    return undefined;
  }

  const { hunk, at, line } = found;
  const from = Math.max(0, at - CONTEXT_LINES);

  return {
    kind: "new",
    filePath: props.filePath,
    index,
    line,
    context: { lines: hunk.slice(from, at + CONTEXT_LINES + 1), at: at - from },
  };
}

const DiffView: ClientModule<DiffViewProps> = (props, surface: ClientSurface) => {
  const { Box, Button, Code, Text } = surface.elements;
  // The language is read off the name; a short path keeps every row small.
  const path = basename(props.filePath);
  const commentOn = (index: number) => props.comments.find((c) => c.index === index);

  // The comment is written in the hooks module's pane: a click here never
  // gives this view the keyboard, a pane opened with `focus` takes it.
  const open = (target: DiffViewTarget | undefined) => {
    if (target !== undefined) {
      surface.post({ target } satisfies DiffViewMessage);
    }
  };

  const startAt = (index: number) => {
    const comment = commentOn(index);
    open(comment === undefined ? newTarget(props, index) : { kind: "reply", id: comment.id });
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
          onPress={() => open({ kind: "edit", id: comment.id })}
        />
      )}
      <Button
        key={`reply-${comment.index}`}
        plain
        dimColor
        label="reply"
        onPress={() => open({ kind: "reply", id: comment.id })}
      />
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

      rows.push(
        <Box flexDirection="row" gap={1}>
          <Button key={`add-${here}`} plain dimColor label="+" onPress={() => startAt(here)} />
          <Box flexGrow={1} flexShrink={1}>
            <Code format="diff" path={path} source={oneLineHunk(line)} />
          </Box>
        </Box>,
      );

      if (comment !== undefined) {
        rows.push(note(comment));
      }
    }
  }

  return <Box flexDirection="column">{rows}</Box>;
};

export default DiffView;
