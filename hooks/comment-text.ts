import type { CommentStatus, DiffComment, LineRef } from "../types";
import { diffRow, lineNumber } from "./diff";

export const RESOLVE_TOOL = "mcp__comment-diff__resolve";

export const STATUS: Record<CommentStatus, { icon: string; color: string }> = {
  pending: { icon: "○", color: "warning" },
  sent: { icon: "◐", color: "suggestion" },
  resolved: { icon: "✓", color: "success" },
};

export function location(ref: LineRef, path = ref.filePath, removedTag = "removed line"): string {
  const removed = ref.line.kind === "removed" ? ` (${removedTag})` : "";

  return `${path}:${lineNumber(ref.line)}${removed}`;
}

export const resolver = (comment: DiffComment) =>
  `resolved by ${comment.resolvedBy === "claude" ? "Claude" : "you"}`;

export function resolvedNote(comment: DiffComment) {
  if (comment.status !== "resolved") {
    return "";
  }

  return comment.resolution
    ? ` — ${resolver(comment)}: ${comment.resolution}`
    : ` — ${resolver(comment)}`;
}

export function countSummary(list: readonly DiffComment[]) {
  const count = (status: CommentStatus) => list.filter((c) => c.status === status).length;

  return `${count("pending")} pending · ${count("sent")} sent · ${count("resolved")} resolved`;
}

const quote = (text: string) =>
  text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

function messagesFor(comment: DiffComment): string {
  const unread = comment.messages.slice(comment.sent);

  if (comment.sent === 0) {
    return unread.join("\n\n");
  }

  const read = comment.messages.slice(0, comment.sent).map(quote).join("\n");

  return `Already sent:\n${read}\n\nNew:\n${unread.join("\n\n")}`;
}

export function reviewPrompt(comments: readonly DiffComment[]): string {
  const intro = [
    `Review comments on your diffs (${comments.length}).`,
    `Handle each one. When a comment is handled, call the ${RESOLVE_TOOL} tool with its id and a one-line note on what you did. If you disagree or need more input, answer instead of resolving it.`,
  ].join("\n");

  const blocks = comments.map((comment) =>
    [
      `[${comment.id}] ${location(comment)}${comment.edited ? " (edited since you read it)" : ""}`,
      "```diff",
      diffRow(comment.line),
      "```",
      messagesFor(comment),
    ].join("\n"),
  );

  return [intro, ...blocks].join("\n\n");
}

// The prompt that starts Claude's turn on a review: the review itself goes in
// as a row the person does not see.
export function reviewLine(ids: readonly string[]): string {
  return `Handle review ${ids.length === 1 ? "comment" : "comments"} ${ids.join(", ")}.`;
}
