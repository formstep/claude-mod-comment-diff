# comment-diff

A [Claude Code](https://claude.com/claude-code) mod that lets you review Claude's edits the way you review a pull request on GitHub: comment on individual lines of a diff, batch the comments into a review, send it, and watch Claude work through and resolve each one.

## Features

- **Line comments on every diff.** Each `Edit` and `Write` result, and each shell command that changes files, is redrawn in the transcript as a commentable diff with a `+` next to every line. Click it to write a comment on that line.
- **Reviews or single comments.** Collect several comments into a review and send them together, or send one comment straight away.
- **Overview above the prompt.** A "Diff comments" list above the prompt box shows every comment with its status, file and line, plus a **Submit review** button.
- **Threads.** Reply to a comment to add to it, edit your last message, or reopen a resolved comment by replying to it.
- **Claude resolves what it fixed.** The mod gives Claude a `resolve` tool. After it handles a comment it marks it resolved with a one-line note on what it did, which shows next to the comment.
- **Works mid-turn.** A comment sent while Claude is busy is delivered with its next tool result, so it does not have to wait for the turn to end.

## Requirements

- Claude Code **2.1.302 or later**, in a terminal session. The diff view is drawn in the terminal only; other surfaces keep the normal diff.
- Mouse clicks enabled in your terminal (the `+`, `edit`, `reply` and the buttons are clickable).

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install comment-diff --marketplace formstep/claude-mod-comment-diff
```

Answer `y` to add the `formstep` marketplace, then press Enter to pick the scope (user scope, the default, enables it in every session). The mod is active immediately, with no restart.

From a shell:

```sh
claude plugin install comment-diff --marketplace formstep/claude-mod-comment-diff
```

In the desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `formstep/claude-mod-comment-diff`, then **Add plugin**.

### Update or remove

```sh
claude plugin update comment-diff
claude plugin uninstall comment-diff
```

## Usage

### 1. Comment on a line

When Claude edits or writes a file, or runs a command that changes one, the diff in the transcript shows a dim `+` beside each line. Click it and a box opens above the prompt with the line and the lines around it. Type the comment in the prompt box itself:

| Key or button | Action |
| --- | --- |
| `Enter` | Add the comment to the review (pending) |
| **Send now** | Send this comment to Claude now |
| **Cancel** | Drop the comment |

Whatever you had typed in the prompt is set aside while you write the comment, and put back after. Slash commands still run as usual.

### 2. Submit the review

Pending comments collect in the **Diff comments** list above the prompt. Press **Submit review (n)** to send them all to Claude in one message. Each comment includes the file, the line and a few lines of surrounding context, so Claude knows exactly what you mean.

### 3. Follow up

Comment status icons:

| Icon | Status |
| --- | --- |
| `○` | Pending: written, not yet sent |
| `◐` | Sent: Claude has it |
| `✓` | Resolved, by you or by Claude (with its note) |

- **Open a comment:** click it in the list. The box opens with its diff context and the comment's last message in the prompt, ready to rewrite, plus **Resolve** and **Delete**. A resolved comment opens as a reply, which reopens it.
- **Reply:** click `reply` under a comment in the diff.
- **Edit:** click `edit` on an unresolved comment. If Claude already read it, the edited text is sent again.
- **Resolve / Delete:** use the buttons in the list or the box. Resolved comments cannot be deleted; they stay as a record.
- **Reopen:** reply to a resolved comment and it becomes pending again.

Comments last for the session. They are not saved between sessions.

### Limits

Very large diffs (past about 90,000 characters of text, roughly 800 lines or more) and errored tool calls keep Claude Code's normal diff view, without comment buttons. Long diffs below that are drawn in several parts, each with its own `+` buttons. Edits a subagent makes are not drawn as diffs in the transcript, so they have no comment buttons either.

## Development

Run the mod from a local clone instead of the installed copy:

```sh
git clone https://github.com/formstep/claude-mod-comment-diff
claude --plugin-dir ./claude-mod-comment-diff
```

Check and test it:

```sh
claude plugin validate .
claude plugin test .
tsc -p .   # after the mod has loaded once, so .claude-plugin/types/ exists
```

Layout:

| Path | What it holds |
| --- | --- |
| `hooks/register.tsx` | Hook wiring and drawing: the diff, the comment list, the comment box above the prompt, the `resolve` tool |
| `hooks/diff-rows.tsx` | The diff's rows: each line with its `+`, and the comments under them |
| `hooks/threads.ts` | The comments' state and every change to it: add, reply, edit, send, resolve, delete |
| `hooks/delivery.ts` | Sending to Claude: as a prompt when idle, or on the next tool result mid-turn |
| `hooks/comment-text.ts` | How comments read: status icons, locations, the review prompt |
| `hooks/diff.ts` | Diff parsing and one-line hunks |
| `types/index.d.ts` | State contract and shared types |
| `tests/` | `claude plugin test` suite |

## License

[MIT](LICENSE)
