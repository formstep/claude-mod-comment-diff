import type { DiffComment, DiffLine, LineRef } from '../types'

export const RESOLVE_TOOL = 'mcp__diff-comments__resolve'

export type ChangedFile = {
  filePath: string
  hunks: DiffLine[][]
}

type Hunk = {
  oldStart: number
  newStart: number
  lines: readonly string[]
}

const MARKER = { added: '+', removed: '-', context: ' ' } as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isHunk = (value: unknown): value is Hunk =>
  isRecord(value) &&
  typeof value.oldStart === 'number' &&
  typeof value.newStart === 'number' &&
  Array.isArray(value.lines)

// Render trees refuse control characters other than tab and newline, and CRLF
// files leave a trailing \r on every patch line.
const printable = (text: string) => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')

export function hunkLines(hunk: Hunk): DiffLine[] {
  let oldLine = hunk.oldStart
  let newLine = hunk.newStart
  const lines: DiffLine[] = []

  for (const raw of hunk.lines) {
    const text = printable(raw.slice(1))

    if (raw.startsWith('+')) {
      lines.push({ kind: 'added', oldLine, newLine, text })
      newLine += 1
    } else if (raw.startsWith('-')) {
      lines.push({ kind: 'removed', oldLine, newLine, text })
      oldLine += 1
    } else if (raw.startsWith(' ')) {
      lines.push({ kind: 'context', oldLine, newLine, text })
      oldLine += 1
      newLine += 1
    }
  }

  return lines
}

function createdLines(content: string): DiffLine[] {
  const rows = content.split('\n')

  if (rows.at(-1) === '') {
    rows.pop()
  }

  return rows.map((row, i) => ({ kind: 'added', oldLine: 1, newLine: i + 1, text: printable(row) }))
}

export function changedFile(output: unknown): ChangedFile | undefined {
  if (!isRecord(output) || typeof output.filePath !== 'string') {
    return undefined
  }

  const patch = Array.isArray(output.structuredPatch) ? output.structuredPatch.filter(isHunk) : []

  if (patch.length > 0) {
    return { filePath: output.filePath, hunks: patch.map(hunkLines) }
  }

  if (output.type === 'create' && typeof output.content === 'string') {
    return { filePath: output.filePath, hunks: [createdLines(output.content)] }
  }

  return undefined
}

export const lineNumber = (line: DiffLine) => (line.kind === 'removed' ? line.oldLine : line.newLine)

// A one-line unified hunk, so the engine's own diff renderer draws each row
// with its gutter, marker and colours while we put a button beside it.
export function oneLineHunk(line: DiffLine): string {
  const oldRange = line.kind === 'added' ? `${Math.max(0, line.oldLine - 1)},0` : `${line.oldLine},1`
  const newRange = line.kind === 'removed' ? `${Math.max(0, line.newLine - 1)},0` : `${line.newLine},1`

  return `@@ -${oldRange} +${newRange} @@\n${MARKER[line.kind]}${line.text}`
}

export const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1)

export function location(ref: LineRef, path = ref.filePath): string {
  const removed = ref.line.kind === 'removed' ? ' (removed line)' : ''

  return `${path}:${lineNumber(ref.line)}${removed}`
}

const quote = (text: string) =>
  text
    .split('\n')
    .map(line => `> ${line}`)
    .join('\n')

function messagesFor(comment: DiffComment): string {
  const unread = comment.messages.slice(comment.sent)

  if (comment.sent === 0) {
    return unread.join('\n\n')
  }

  const read = comment.messages.slice(0, comment.sent).map(quote).join('\n')

  return `Already sent:\n${read}\n\nNew:\n${unread.join('\n\n')}`
}

export function reviewPrompt(comments: readonly DiffComment[]): string {
  const intro = [
    `Review comments on your diffs (${comments.length}).`,
    `Handle each one. When a comment is handled, call the ${RESOLVE_TOOL} tool with its id and a one-line note on what you did. If you disagree or need more input, answer instead of resolving it.`,
  ].join('\n')

  const blocks = comments.map(comment =>
    [
      `[${comment.id}] ${location(comment)}${comment.edited ? ' (edited since you read it)' : ''}`,
      '```diff',
      `${MARKER[comment.line.kind]}${comment.line.text}`,
      '```',
      messagesFor(comment),
    ].join('\n'),
  )

  return [intro, ...blocks].join('\n\n')
}
