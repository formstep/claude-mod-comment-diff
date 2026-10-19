import { atom, read, update } from "claude-code";
import type { EngineInterface, Register } from "claude-code";

import type {
  CommentStatus,
  DiffComment,
  DiffViewMessage,
  DiffViewProps,
  LineContext,
  LineRef,
} from "../types";
import { basename, changedFile, location, oneLineHunk, reviewPrompt } from "./diff";

const DIFF_TOOLS = new Set(["Edit", "Write"]);
// Every row is its own Code element, and a Client's props stop at 100,000
// characters; past either a diff is left to the engine.
const MAX_ROWS = 400;
const MAX_PROPS = 90_000;
const PANE = "diff-comment";

const threads = atom({ plugin: "diff-comments", key: "threads" } as const, []);
const viewing = atom({ plugin: "diff-comments", key: "viewing" } as const, null);
const seq = atom({ plugin: "diff-comments", key: "seq" } as const, 0);

// A plugin's prompt reaches Claude only once it is idle. Mid-turn, comments
// sent now ride on the next tool result of the main loop instead.
let isMainTurnRunning = false;
let agentTurnsRunning = 0;
let outbox: string[] = [];

const STATUS: Record<CommentStatus, { icon: string; color: string }> = {
  pending: { icon: "○", color: "warning" },
  sent: { icon: "◐", color: "suggestion" },
  resolved: { icon: "✓", color: "success" },
};

const oneLine = (text: string) => text.replace(/\s*\n\s*/g, " ");

const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;

const plural = (n: number) => `${n} ${n === 1 ? "line" : "lines"}`;

function changeSummary(added: number, removed: number) {
  if (added > 0 && removed > 0) {
    return `Added ${plural(added)}, removed ${plural(removed)}`;
  }

  return added > 0 ? `Added ${plural(added)}` : `Removed ${plural(removed)}`;
}

function countSummary(list: readonly DiffComment[]) {
  const count = (status: CommentStatus) => list.filter((c) => c.status === status).length;

  return `${count("pending")} pending · ${count("sent")} sent · ${count("resolved")} resolved`;
}

const resolver = (comment: DiffComment) =>
  `resolved by ${comment.resolvedBy === "claude" ? "Claude" : "you"}`;

function resolvedNote(comment: DiffComment) {
  if (comment.status !== "resolved") {
    return "";
  }

  return comment.resolution
    ? ` — ${resolver(comment)}: ${comment.resolution}`
    : ` — ${resolver(comment)}`;
}

// GitHub's wording: the first pending comment starts a review, later ones join it.
const reviewLabel = (list: readonly DiffComment[]) =>
  list.some((c) => c.status === "pending") ? "Add review comment" : "Start a review";

async function addComment(
  $: EngineInterface,
  { toolUseId, filePath, index, line }: LineRef,
  context: LineContext,
  text: string,
) {
  const n = await update($, seq, (last) => last + 1);
  const comment: DiffComment = {
    toolUseId,
    filePath,
    index,
    line,
    context,
    id: `c${n}`,
    messages: [text],
    sent: 0,
    status: "pending",
  };
  await update($, threads, (all) => [...all, comment]);

  return comment.id;
}

// A message added to a resolved comment reopens it, so Claude reads it.
async function extendComment($: EngineInterface, id: string, text: string) {
  if (!(await read($, threads)).some((c) => c.id === id)) {
    $.ui.toast(`${id} was deleted meanwhile, so the message was not added`);
    return undefined;
  }

  await update($, threads, (all) =>
    all.map((c) => {
      if (c.id !== id) {
        return c;
      }

      const { resolvedBy, resolution, ...rest } = c;

      return { ...rest, messages: [...c.messages, text], status: "pending" };
    }),
  );

  return id;
}

async function editComment($: EngineInterface, id: string, text: string) {
  const before = (await read($, threads)).find((c) => c.id === id);

  if (before === undefined || before.status === "resolved") {
    $.ui.toast(`${id} was ${before ? "resolved" : "deleted"} meanwhile, so the edit was not saved`);
    return;
  }

  await update($, threads, (all) =>
    all.map((c) => {
      if (c.id !== id) {
        return c;
      }

      const last = c.messages.length - 1;
      const messages = [...c.messages.slice(0, last), text];

      // Claude has read the message being edited: it goes out again.
      return last < c.sent
        ? { ...c, messages, sent: last, status: "pending", edited: true }
        : { ...c, messages };
    }),
  );
}

async function submitComments(
  $: EngineInterface,
  toSend: readonly DiffComment[],
  mode: "review" | "now",
) {
  if (toSend.length === 0) {
    return;
  }

  const before = new Map(toSend.map((c) => [c.id, c]));
  const text = reviewPrompt(toSend);

  // Marked before submitting: the submit waits until Claude is idle, and a
  // second press meanwhile must not send the same comments twice.
  await update($, threads, (all) =>
    all.map((c) => {
      if (!before.has(c.id) || c.status === "resolved") {
        return c;
      }

      const { edited, ...rest } = c;

      return { ...rest, sent: c.messages.length, status: "sent" };
    }),
  );

  if (mode === "now" && isMainTurnRunning) {
    outbox = [...outbox, text];
    return;
  }

  const putBack = (reason: string) => {
    $.ui.toast(reason);

    return update($, threads, (all) =>
      all.map((c) => {
        const old = before.get(c.id);

        return old !== undefined && c.status === "sent"
          ? { ...c, sent: old.sent, status: "pending", ...(old.edited ? { edited: true } : {}) }
          : c;
      }),
    );
  };

  try {
    const sent = await $.prompt.submit({ text, asUser: true });

    if (sent.drop !== undefined) {
      await putBack(`The comments were not sent: ${sent.drop}`);
    }
  } catch (error) {
    await putBack(
      `Could not send the comments: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function sendNow($: EngineInterface, id: string) {
  const comment = (await read($, threads)).find((c) => c.id === id);

  if (comment?.status === "pending") {
    await submitComments($, [comment], "now");
  }
}

async function submitReview($: EngineInterface) {
  await submitComments(
    $,
    (await read($, threads)).filter((c) => c.status === "pending"),
    "review",
  );
}

async function resolve(
  $: EngineInterface,
  ids: ReadonlySet<string>,
  by: "person" | "claude",
  note?: string,
) {
  await update($, threads, (all) =>
    all.map((c) =>
      ids.has(c.id) && c.status !== "resolved"
        ? { ...c, status: "resolved", resolvedBy: by, ...(note ? { resolution: note } : {}) }
        : c,
    ),
  );
}

async function remove($: EngineInterface, id: string) {
  await update($, threads, (all) => all.filter((c) => c.id !== id || c.status === "resolved"));

  if ((await read($, viewing)) === id) {
    await $.ui.close({ id: PANE });
  }
}

async function view($: EngineInterface, comment: DiffComment) {
  await update($, viewing, () => comment.id);

  const opened = await $.ui.open({
    id: PANE,
    title: `${comment.id} · ${location(comment, basename(comment.filePath))}`,
    focus: true,
    closeOnEscape: true,
    rows: comment.context.lines.length + comment.messages.length + 6,
  });

  if (!opened.isPlaced) {
    await update($, viewing, () => null);
    $.ui.toast(`Can't open ${comment.id}: ${opened.reason}`);
  }
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    await $.tool.register({
      name: "resolve",
      description:
        'Marks review comments the person left on lines of your diffs as resolved. Call it once you have handled a comment, with the comment ids from the review message (like "c3") and a one-line note on what you did.',
      inputSchema: {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "string" }, description: 'Comment ids, like "c3"' },
          note: { type: "string", description: "What you did, in one line" },
        },
        required: ["ids"],
      },
      isDeferred: false,
    });

    return next(e);
  });

  on("tool.call", { tool: "mcp__diff-comments__resolve" }, async ($, e) => {
    const asked = Array.isArray(e.ids)
      ? e.ids.filter((id): id is string => typeof id === "string")
      : [];
    const note = typeof e.note === "string" ? e.note.trim() : undefined;
    const byId = new Map((await read($, threads)).map((c) => [c.id, c]));

    const open = asked.filter(
      (id) => byId.get(id)?.status === "sent" || byId.get(id)?.status === "pending",
    );
    const already = asked.filter((id) => byId.get(id)?.status === "resolved");
    const unknown = asked.filter((id) => !byId.has(id));

    await resolve($, new Set(open), "claude", note);

    const parts = [
      open.length > 0 ? `Resolved ${open.join(", ")}.` : "Resolved nothing.",
      already.length > 0 ? `Already resolved: ${already.join(", ")}.` : "",
      unknown.length > 0
        ? `No such comment (the person may have deleted it): ${unknown.join(", ")}.`
        : "",
    ];

    return { result: parts.filter(Boolean).join(" ") };
  });

  on("turn.start", async (_$, e, next) => {
    if (e.agentId === undefined) {
      isMainTurnRunning = true;
    } else {
      agentTurnsRunning += 1;
    }

    return next(e);
  });

  on("tool.call", async (_$, e, next) => {
    const done = await next(e);

    // While a subagent runs, a tool result may be its, not Claude's.
    if (done.deny !== undefined || outbox.length === 0 || agentTurnsRunning > 0) {
      return done;
    }

    const delivered = outbox;
    outbox = [];

    return { ...done, context: [...(done.context ?? []), ...delivered] };
  });

  on("turn.complete", async ($, e, next) => {
    const done = await next(e);

    if (e.agentId !== undefined) {
      agentTurnsRunning = Math.max(0, agentTurnsRunning - 1);
      return done;
    }

    isMainTurnRunning = false;

    if (outbox.length > 0) {
      const left = outbox.join("\n\n");
      outbox = [];
      void $.prompt.submit({ text: left, asUser: true });
    }

    return done;
  });

  on("ui.message", async ($, e) => {
    const message = e.data as DiffViewMessage;
    const text = typeof message.text === "string" ? message.text.trim() : "";

    if (text === "") {
      return {};
    }

    if (message.edits !== undefined) {
      await editComment($, message.edits, text);

      if (message.action === "single") {
        await sendNow($, message.edits);
      }

      return {};
    }

    const { filePath, index, line, context } = message;
    const id =
      message.extends === undefined
        ? await addComment($, { toolUseId: e.requestId, filePath, index, line }, context, text)
        : await extendComment($, message.extends, text);

    if (id !== undefined && message.action === "single") {
      await sendNow($, id);
    }

    return {};
  });

  // While a comment is open in its pane, the prompt box adds to it.
  on("prompt.submit", async ($, e, next) => {
    const id = await read($, viewing);
    const text = e.text.trim();

    if (id === null || e.origin.kind !== "composer" || e.command !== undefined || text === "") {
      return next(e);
    }

    if ((await extendComment($, id, text)) === undefined) {
      return next(e);
    }

    // Cleared in case the engine hands a dropped prompt back to the box.
    $.clock.after(0, () => void $.prompt.fill({ text: "" }));

    return { drop: `Added to ${id}` };
  });

  on("ui.close", { id: PANE }, async ($, e, next) => {
    await update($, viewing, () => null);

    return next(e);
  });

  on("ui.render", { component: "ToolResult" }, async ($, e, next) => {
    if (e.surface !== "terminal" || e.props.isErrored || !DIFF_TOOLS.has(e.props.tool)) {
      return next(e);
    }

    const file = changedFile(e.props.output);
    const lines = file?.hunks.flat() ?? [];

    if (file === undefined || lines.length === 0 || lines.length > MAX_ROWS) {
      return next(e);
    }

    const all = await read($, threads);
    const props: DiffViewProps = {
      filePath: file.filePath,
      summary: changeSummary(
        lines.filter((l) => l.kind === "added").length,
        lines.filter((l) => l.kind === "removed").length,
      ),
      hunks: file.hunks,
      comments: all
        .filter((c) => c.toolUseId === e.requestId)
        .map((c) => ({
          id: c.id,
          index: c.index,
          messages: c.messages,
          status: c.status,
          note: resolvedNote(c),
        })),
      reviewLabel: reviewLabel(all),
    };

    if (JSON.stringify(props).length > MAX_PROPS) {
      return next(e);
    }

    const { Client } = $.ui.resolve(e);

    return (
      <Client key={`diff-${e.requestId}`} module="./diff-view.tsx" props={props} width="100%" />
    );
  });

  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const { Box, Button, Code, Text } = $.ui.resolve(e);
    const id = await read($, viewing);
    const comment = (await read($, threads)).find((c) => c.id === id);

    if (comment === undefined) {
      return <Text dimColor>This comment was deleted.</Text>;
    }

    const isOpen = comment.status !== "resolved";

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text color={STATUS[comment.status].color}>{STATUS[comment.status].icon}</Text>
          <Text weight="bold">{comment.id}</Text>
          <Text dimColor>
            {location(comment, basename(comment.filePath))}
            {resolvedNote(comment)}
          </Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {comment.context.lines.map((line, i) => (
            <Box flexDirection="row">
              <Text color="warning">{i === comment.context.at ? "›" : " "}</Text>
              <Text> </Text>
              <Box flexGrow={1} flexShrink={1}>
                <Code format="diff" path={comment.filePath} source={oneLineHunk(line)} />
              </Box>
            </Box>
          ))}
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {comment.messages.map((message, i) => (
            <Text>
              {message}
              <Text dimColor>{i < comment.sent ? "" : " · not sent yet"}</Text>
            </Text>
          ))}
        </Box>
        <Box flexDirection="row" gap={1} marginTop={1}>
          <Box flexGrow={1} flexShrink={1}>
            <Text dimColor>
              {isOpen ? "Type in the prompt to add to it" : "Type in the prompt to reopen it"} ·
              Esc closes
            </Text>
          </Box>
          {isOpen && (
            <Button
              key="pane-resolve"
              onPress={() => resolve($, new Set([comment.id]), "person")}
            >
              <Text color="success">Resolve</Text>
            </Button>
          )}
          {isOpen && (
            <Button key="pane-delete" onPress={() => remove($, comment.id)}>
              <Text color="error">Delete</Text>
            </Button>
          )}
        </Box>
      </Box>
    );
  });

  on("ui.render", { component: "PromptHint" }, async ($, e, next) => {
    const list = await read($, threads);
    const viewed = await read($, viewing);
    const hint =
      viewed === null
        ? await next(e)
        : await next({
            ...e,
            props: { ...e.props, tail: `· Enter adds to ${viewed} · Esc closes it` },
          });

    if (list.length === 0) {
      return hint;
    }

    const { Box, Button, Text } = $.ui.resolve(e);
    const columns = e.viewport?.columns ?? 80;
    const pending = list.filter((c) => c.status === "pending").length;
    const ordered = [
      ...list.filter((c) => c.status !== "resolved"),
      ...list.filter((c) => c.status === "resolved"),
    ];

    return (
      <Box flexDirection="column">
        {hint}
        <Box flexDirection="row" gap={1} marginTop={1}>
          <Box flexDirection="row" flexGrow={1} gap={1}>
            <Text weight="bold">Diff comments</Text>
            <Text dimColor>{countSummary(list)}</Text>
          </Box>
          {pending > 0 && (
            <Button
              key="submit-review"
              variant="primary"
              label={`Submit review (${pending})`}
              onPress={() => submitReview($)}
            />
          )}
        </Box>
        {ordered.map((comment) => {
          const isOpen = comment.status !== "resolved";
          const where = location(comment, basename(comment.filePath)).replace(
            " (removed line)",
            " (removed)",
          );
          const side = isOpen ? "[ Resolve ] [ Delete ]" : resolver(comment);
          const room = columns - comment.id.length - where.length - side.length - 9;
          const said = comment.messages.map(oneLine).join(" · ");

          return (
            <Box key={`comment-${comment.id}`} flexDirection="row" gap={1}>
              <Box flexDirection="row" flexGrow={1} flexShrink={1}>
                <Button key={`go-${comment.id}`} plain onPress={() => view($, comment)}>
                  <Text color={STATUS[comment.status].color}>{STATUS[comment.status].icon}</Text>{" "}
                  <Text dimColor>{comment.id}</Text>{" "}
                  <Text dimColor={!isOpen}>{truncate(said, Math.max(12, room))}</Text>
                  {"  "}
                  <Text dimColor>{where}</Text>
                </Button>
              </Box>
              {isOpen && (
                <Button
                  key={`resolve-${comment.id}`}
                  onPress={() => resolve($, new Set([comment.id]), "person")}
                >
                  <Text color="success">Resolve</Text>
                </Button>
              )}
              {isOpen && (
                <Button key={`delete-${comment.id}`} onPress={() => remove($, comment.id)}>
                  <Text color="error">Delete</Text>
                </Button>
              )}
              {!isOpen && <Text dimColor>{side}</Text>}
            </Box>
          );
        })}
      </Box>
    );
  });
};
