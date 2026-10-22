import type { ElementTable, RenderElement } from "claude-code";

import type { CommentTarget, DiffComment, DiffLine, LineContext } from "../types";
import { resolvedNote, STATUS } from "./comment-text";
import { basename, CONTEXT_LINES, oneLineHunk } from "./diff";
import type { ChangedFile } from "./diff";

type RowElements = Pick<ElementTable<"terminal">, "Box" | "Button" | "Code" | "Text">;

// The line at `at` with the lines of its hunk around it.
function contextAt(hunk: readonly DiffLine[], at: number): LineContext {
  const from = Math.max(0, at - CONTEXT_LINES);

  return { lines: hunk.slice(from, at + CONTEXT_LINES + 1), at: at - from };
}

// The file's rows, each line with its + and any comment on it under it; the
// lines are numbered across the tool call's files from `first`.
//
// Drawn in the hooks module's tree, not a Client's: the engine seats a pane
// opened for a press on a Button a hook drew at any width, and one opened for
// a Client's message only from 144 columns.
export function diffRows(
  { Box, Button, Code, Text }: RowElements,
  file: ChangedFile,
  first: number,
  comments: readonly DiffComment[],
  open: (target: CommentTarget) => void,
): RenderElement[] {
  // The language is read off the name; a short path keeps every row small.
  const path = basename(file.filePath);
  const byIndex = new Map(comments.map((c) => [c.index, c]));

  const note = (comment: DiffComment) => (
    <Box flexDirection="row" gap={1} paddingLeft={4}>
      <Text color={STATUS[comment.status].color}>{STATUS[comment.status].icon}</Text>
      <Text dimColor>{comment.id}</Text>
      <Box flexDirection="column" flexShrink={1}>
        {comment.messages.map((message, i) => (
          <Text dimColor={comment.status === "resolved"}>
            {message}
            <Text dimColor>{i === comment.messages.length - 1 ? resolvedNote(comment) : ""}</Text>
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

  const rows: RenderElement[] = [];
  let index = first;

  for (const [hunkIndex, hunk] of file.hunks.entries()) {
    if (hunkIndex > 0) {
      rows.push(<Text dimColor> ...</Text>);
    }

    for (const [at, line] of hunk.entries()) {
      const here = index;
      index += 1;

      const comment = byIndex.get(here);
      const target: CommentTarget =
        comment === undefined
          ? { kind: "new", filePath: file.filePath, index: here, line, context: contextAt(hunk, at) }
          : { kind: "reply", id: comment.id };

      rows.push(
        <Box flexDirection="row" gap={1}>
          <Button key={`add-${here}`} plain dimColor label="+" onPress={() => open(target)} />
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

  return rows;
}
