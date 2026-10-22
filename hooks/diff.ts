import type { DiffLine } from "../types";

export type ChangedFile = {
  filePath: string;
  hunks: DiffLine[][];
};

// Lines of the hunk kept on each side of a commented line.
export const CONTEXT_LINES = 3;

type Hunk = {
  oldStart: number;
  newStart: number;
  lines: readonly string[];
};

const MARKER = { added: "+", removed: "-", context: " " } as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isHunk = (value: unknown): value is Hunk =>
  isRecord(value) &&
  typeof value.oldStart === "number" &&
  typeof value.newStart === "number" &&
  Array.isArray(value.lines);

// Render trees refuse control characters other than tab and newline, and CRLF
// files leave a trailing \r on every patch line.
const printable = (text: string) => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");

function hunkLines(hunk: Hunk): DiffLine[] {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  const lines: DiffLine[] = [];

  for (const raw of hunk.lines) {
    const text = printable(raw.slice(1));

    if (raw.startsWith("+")) {
      lines.push({ kind: "added", oldLine, newLine, text });
      newLine += 1;
    } else if (raw.startsWith("-")) {
      lines.push({ kind: "removed", oldLine, newLine, text });
      oldLine += 1;
    } else if (raw.startsWith(" ")) {
      lines.push({ kind: "context", oldLine, newLine, text });
      oldLine += 1;
      newLine += 1;
    }
  }

  return lines;
}

function createdLines(content: string): DiffLine[] {
  const rows = content.split("\n");

  if (rows.at(-1) === "") {
    rows.pop();
  }

  return rows.map((row, i) => ({
    kind: "added",
    oldLine: 1,
    newLine: i + 1,
    text: printable(row),
  }));
}

export function changedFile(output: unknown): ChangedFile | undefined {
  if (!isRecord(output) || typeof output.filePath !== "string") {
    return undefined;
  }

  const patch = Array.isArray(output.structuredPatch) ? output.structuredPatch.filter(isHunk) : [];

  if (patch.length > 0) {
    return { filePath: output.filePath, hunks: patch.map(hunkLines) };
  }

  if (output.type === "create" && typeof output.content === "string") {
    return { filePath: output.filePath, hunks: [createdLines(output.content)] };
  }

  return undefined;
}

export const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

const plural = (n: number) => `${n} ${n === 1 ? "line" : "lines"}`;

export function changeSummary(lines: readonly DiffLine[]): string {
  const added = lines.filter((l) => l.kind === "added").length;
  const removed = lines.filter((l) => l.kind === "removed").length;

  if (added > 0 && removed > 0) {
    return `Added ${plural(added)}, removed ${plural(removed)}`;
  }

  return added > 0 ? `Added ${plural(added)}` : `Removed ${plural(removed)}`;
}

export const lineNumber = (line: DiffLine) =>
  line.kind === "removed" ? line.oldLine : line.newLine;

// The line as a unified diff writes it: marker, then text.
export const diffRow = (line: DiffLine) => `${MARKER[line.kind]}${line.text}`;

// A one-line unified hunk, so the engine's own diff renderer draws each row
// with its gutter, marker and colours while we put a button beside it.
export function oneLineHunk(line: DiffLine): string {
  const oldRange =
    line.kind === "added" ? `${Math.max(0, line.oldLine - 1)},0` : `${line.oldLine},1`;
  const newRange =
    line.kind === "removed" ? `${Math.max(0, line.newLine - 1)},0` : `${line.newLine},1`;

  return `@@ -${oldRange} +${newRange} @@\n${diffRow(line)}`;
}

// The characters of text a diff's rows draw: each line's one-line hunk and
// its + label.
export const drawnText = (lines: readonly DiffLine[]) =>
  lines.reduce((sum, line) => sum + oneLineHunk(line).length + 1, 0);
