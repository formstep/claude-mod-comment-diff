import type { DiffLine, DiffViewProps } from "../types";

export type ChangedFile = {
  filePath: string;
  hunks: DiffLine[][];
};

// A run of a diff's lines that one view draws.
export type DiffChunk = Pick<DiffViewProps, "first" | "hunks" | "lead" | "tail"> & {
  // Whether its first line goes on with a hunk the view before it draws.
  continuesHunk: boolean;
};

// Lines of the hunk kept on each side of a commented line.
export const CONTEXT_LINES = 3;

// The engine unmounts a view whose tree serializes past 100,000 characters.
// A row costs about ROW_COST plus its text, the file's name and the hunk
// header; each view holds rows up to VIEW_BUDGET, leaving the rest for the
// comments and the comment box drawn between them.
const ROW_COST = 340;
const VIEW_BUDGET = 70_000;

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

// Splits the diff into runs of lines that each fit one view, cutting a long
// hunk where it must and handing each side of the cut the other's context.
export function chunked(file: ChangedFile): DiffChunk[] {
  const name = basename(file.filePath);
  const chunks: DiffChunk[] = [];
  let index = 0;
  let cost = 0;

  for (const hunk of file.hunks) {
    for (const [at, line] of hunk.entries()) {
      const rowCost = ROW_COST + name.length + JSON.stringify(oneLineHunk(line)).length;
      const last = chunks.at(-1);

      if (last === undefined || cost + rowCost > VIEW_BUDGET) {
        if (last !== undefined && at > 0) {
          last.tail = hunk.slice(at, at + CONTEXT_LINES);
        }

        chunks.push({
          first: index,
          hunks: [[line]],
          lead: hunk.slice(Math.max(0, at - CONTEXT_LINES), at),
          tail: [],
          continuesHunk: at > 0,
        });
        cost = 0;
      } else if (at === 0) {
        last.hunks.push([line]);
      } else {
        last.hunks.at(-1)?.push(line);
      }

      cost += rowCost;
      index += 1;
    }
  }

  return chunks;
}

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
