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

// Lines as a unified diff writes them (marker, then text), numbered from the
// first one's: about half the characters of each line as a DiffLine, which
// keeps a long diff within the room a tree holds for its views' props.
export type DiffRun = {
  oldStart: number;
  newStart: number;
  lines: string[];
};

// A long diff is drawn by several views, each holding a run of its lines.
export type DiffViewProps = {
  filePath: string;
  // The index, across the whole diff, of the view's first line.
  first: number;
  hunks: DiffRun[];
  // The lines just before and after the view's own, in the same hunk, which a
  // neighbouring view draws: the context a comment at the view's edge needs.
  lead: DiffRun;
  tail: DiffRun;
  // Only the comments on the view's own lines.
  comments: DiffViewComment[];
};

// What the diff view posts to open the comment pane: a new comment on a line,
// a reply to a comment, or an edit of its last message.
export type DiffViewTarget =
  | { kind: "new"; filePath: string; index: number; line: DiffLine; context: LineContext }
  | { kind: "reply" | "edit"; id: string };

export type DiffViewMessage = {
  target: DiffViewTarget;
};

// The comment being written in the pane, and the tool call whose diff it is on.
export type CommentDraft = {
  toolUseId: string;
  target: DiffViewTarget;
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
