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
};

export type DiffViewComment = {
  id: string;
  index: number;
  messages: string[];
  status: CommentStatus;
  note: string;
};

// A long diff is drawn by several views, each holding a run of its lines.
export type DiffViewProps = {
  filePath: string;
  // The index, across the whole diff, of the view's first line.
  first: number;
  hunks: DiffLine[][];
  // The lines just before and after the view's own, in the same hunk, which a
  // neighbouring view draws: the context a comment at the view's edge needs.
  lead: DiffLine[];
  tail: DiffLine[];
  comments: DiffViewComment[];
  reviewLabel: string;
};

// What the diff view posts: a new comment on a line, a reply to a comment, or
// an edit of its last message; `sendNow` sends it to Claude at once.
export type DiffViewTarget =
  | { kind: "new"; filePath: string; index: number; line: DiffLine; context: LineContext }
  | { kind: "reply" | "edit"; id: string };

export type DiffViewMessage = {
  target: DiffViewTarget;
  text: string;
  sendNow: boolean;
};

declare module "claude-code" {
  interface PluginState {
    "comment-diff": {
      threads: DiffComment[];
      viewing: string | null;
      seq: number;
    };
  }

  interface McpToolInputs {
    "mcp__comment-diff__resolve": { ids: string[]; note?: string };
  }
}
