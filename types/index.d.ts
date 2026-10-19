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

export type DiffComment = LineRef & {
  id: string;
  messages: string[];
  sent: number;
  status: CommentStatus;
  context: LineContext;
  edited?: true;
  resolvedBy?: "person" | "claude";
  resolution?: string;
};

export type DiffViewComment = {
  id: string;
  index: number;
  messages: string[];
  status: CommentStatus;
  note: string;
};

export type DiffViewProps = {
  filePath: string;
  summary: string;
  hunks: DiffLine[][];
  comments: DiffViewComment[];
  reviewLabel: string;
};

export type DiffViewMessage = {
  action: "single" | "review" | "update";
  filePath: string;
  index: number;
  line: DiffLine;
  context: LineContext;
  edits?: string;
  extends?: string;
  text: string;
};

declare module "claude-code" {
  interface PluginState {
    "diff-comments": {
      threads: DiffComment[];
      viewing: string | null;
      seq: number;
    };
  }

  interface McpToolInputs {
    "mcp__diff-comments__resolve": { ids: string[]; note?: string };
  }
}
