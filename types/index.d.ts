export type DiffLineKind = "added" | "removed" | "context";

export type DiffLine = {
  kind: DiffLineKind;
  oldLine: number;
  newLine: number;
  text: string;
};

export type LineRef = {
  toolUseId: string;
  filePath: string;
  index: number;
  line: DiffLine;
};

export type LineContext = {
  lines: DiffLine[];
  at: number;
};

export type CommentStatus = "pending" | "sent" | "resolved";

export type Resolver = "person" | "claude";

export type DiffComment = LineRef & {
  id: string;
  messages: string[];
  sent: number;
  status: CommentStatus;
  context: LineContext;
  edited?: true;
  resolvedBy?: Resolver;
  resolution?: string;
  // When it was resolved, in milliseconds since the epoch.
  resolvedAt?: number;
  // Out of the list above the prompt, a while after it was resolved; the
  // diff keeps it under its line.
  unlisted?: true;
};

// What a press in the diff opens the comment pane on: a new comment on a
// line, a reply to a comment, or an edit of its last message.
export type CommentTarget =
  | { kind: "new"; filePath: string; index: number; line: DiffLine; context: LineContext }
  | { kind: "reply" | "edit"; id: string };

// The comment being written in the prompt box, the tool call whose diff it is
// on, and the person's own draft, set aside until the comment is done.
export type CommentDraft = {
  toolUseId: string;
  target: CommentTarget;
  aside: string;
};

declare module "claude-code" {
  interface PluginState {
    "comment-diff": {
      threads: DiffComment[];
      draft: CommentDraft | null;
      seq: number;
    };
  }

  interface McpToolInputs {
    "mcp__comment-diff__resolve": { ids: string[]; note?: string };
  }
}
