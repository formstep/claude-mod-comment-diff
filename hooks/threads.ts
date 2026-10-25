import { atom, read, update } from "claude-code";
import type { EngineInterface } from "claude-code";

import type { DiffComment, CommentTarget, Resolver } from "../types";
import { reviewPrompt } from "./comment-text";
import { deliver } from "./delivery";

// How long a resolved comment stays in the list above the prompt.
const RESOLVED_LISTED_MS = 60_000;

const threads = atom({ plugin: "comment-diff", key: "threads" } as const, []);
const seq = atom({ plugin: "comment-diff", key: "seq" } as const, 0);

// The engine's scan follows $ into a function declaration only, and reads an
// atom only in the file that declares it, so this file owns the comments.
export function readThreads($: EngineInterface) {
  return read($, threads);
}

// Rewrites the comments `ids` names in one write; resolves the list as written.
function patch(
  $: EngineInterface,
  ids: ReadonlySet<string>,
  change: (comment: DiffComment) => DiffComment,
) {
  return update($, threads, (all) => all.map((c) => (ids.has(c.id) ? change(c) : c)));
}

async function addComment(
  $: EngineInterface,
  toolUseId: string,
  { filePath, index, line, context }: Extract<CommentTarget, { kind: "new" }>,
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
  const all = await patch(
    $,
    new Set([id]),
    ({ resolvedBy, resolution, resolvedAt, unlisted, ...rest }) => ({
      ...rest,
      messages: [...rest.messages, text],
      status: "pending",
    }),
  );

  if (!all.some((c) => c.id === id)) {
    $.ui.toast(`${id} was deleted meanwhile, so the message was not added`);
    return undefined;
  }

  return id;
}

async function editComment($: EngineInterface, id: string, text: string) {
  const all = await patch($, new Set([id]), (c) => {
    if (c.status === "resolved") {
      return c;
    }

    const last = c.messages.length - 1;
    const messages = [...c.messages.slice(0, last), text];

    // Claude has read the message being edited: it goes out again.
    return last < c.sent
      ? { ...c, messages, sent: last, status: "pending", edited: true }
      : { ...c, messages };
  });
  const after = all.find((c) => c.id === id);

  if (after === undefined || after.status === "resolved") {
    $.ui.toast(`${id} was ${after ? "resolved" : "deleted"} meanwhile, so the edit was not saved`);
    return undefined;
  }

  return id;
}

// Saves what the diff view posted; resolves the comment's id, or undefined
// when it was not saved.
export function saveMessage(
  $: EngineInterface,
  toolUseId: string,
  target: CommentTarget,
  text: string,
) {
  switch (target.kind) {
    case "new":
      return addComment($, toolUseId, target, text);
    case "reply":
      return extendComment($, target.id, text);
    case "edit":
      return editComment($, target.id, text);
  }
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
  await patch($, new Set(before.keys()), (c) => {
    if (c.status === "resolved") {
      return c;
    }

    const { edited, ...rest } = c;

    return { ...rest, sent: c.messages.length, status: "sent" };
  });

  await deliver(
    $,
    { ids: [...before.keys()], text, onFailure: (reason) => putBack($, before, reason) },
    mode,
  );
}

// A send that did not arrive leaves its comments pending, as Claude last read
// them, even where a message was added or edited while it was on its way.
async function putBack(
  $: EngineInterface,
  before: ReadonlyMap<string, DiffComment>,
  reason: string,
) {
  $.ui.toast(reason);
  await patch($, new Set(before.keys()), (c) => {
    const old = before.get(c.id);

    if (old === undefined || c.status === "resolved") {
      return c;
    }

    const { edited, ...rest } = c;

    return {
      ...rest,
      sent: Math.min(c.sent, old.sent),
      status: "pending",
      ...(old.edited ? { edited: true } : {}),
    };
  });
}

export async function sendNow($: EngineInterface, id: string) {
  const comment = (await readThreads($)).find((c) => c.id === id);

  if (comment?.status === "pending") {
    await submitComments($, [comment], "now");
  }
}

export async function submitReview($: EngineInterface) {
  await submitComments(
    $,
    (await readThreads($)).filter((c) => c.status === "pending"),
    "review",
  );
}

// Resolves the list as written.
export async function resolve(
  $: EngineInterface,
  ids: ReadonlySet<string>,
  by: Resolver,
  note?: string,
) {
  const at = await $.clock.now();
  const all = await patch($, ids, (c) =>
    c.status === "resolved"
      ? c
      : {
          ...c,
          status: "resolved",
          resolvedBy: by,
          resolvedAt: at,
          ...(note ? { resolution: note } : {}),
        },
  );
  unlistLater($, at, at);

  return all;
}

// Takes the comments resolved at `at` out of the list; one reopened since, or
// resolved again, has another time and stays.
function unlistLater($: EngineInterface, at: number, now: number) {
  $.clock.after(Math.max(0, at + RESOLVED_LISTED_MS - now), () => {
    void update($, threads, (all) =>
      all.map((c): DiffComment =>
        c.status === "resolved" && (c.resolvedAt ?? 0) === at ? { ...c, unlisted: true } : c,
      ),
    );
  });
}

// Timers end with the module, so after a reload each resolved comment still
// listed is timed again, from when it was resolved.
export async function timeResolved($: EngineInterface) {
  const now = await $.clock.now();
  const listed = (await readThreads($)).filter((c) => c.status === "resolved" && !c.unlisted);

  for (const at of new Set(listed.map((c) => c.resolvedAt ?? 0))) {
    unlistLater($, at, now);
  }
}

// Resolved comments cannot be deleted: they stay as a record.
export async function deleteComment($: EngineInterface, id: string) {
  await update($, threads, (all) => all.filter((c) => c.id !== id || c.status === "resolved"));
}
