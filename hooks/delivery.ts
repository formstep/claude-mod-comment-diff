import type { EngineInterface, Hook } from "claude-code";

import { reviewLine } from "./comment-text";

// What goes to Claude, the comments it carries, and what to do when it does
// not arrive.
export type Parcel = {
  ids: readonly string[];
  text: string;
  onFailure: (reason: string) => Promise<void>;
};

// A plugin's prompt reaches Claude only once it is idle. Mid-turn, comments
// sent now ride on the next tool result of the main loop instead, and a
// review waits for the turn to end.
let isMainTurnRunning = false;
let agentTurnsRunning = 0;
let outbox: Parcel[] = [];
let held: Parcel[] = [];

// Submits `text` for Claude; resolves why it was not sent, if it was not.
//
// The transcript draws a plugin's prompt whole and runs none of the plugin's
// own hooks on that row, so the text goes in as a row the person does not
// see, and the prompt that starts the turn only names the comments. Called
// while Claude is idle, so that row is read with the prompt, not mid-turn.
async function trySubmit($: EngineInterface, text: string, ids: readonly string[]) {
  try {
    const appended = await $.session.append({
      message: { type: "user", content: [{ type: "text", text }] },
    });
    const prompt = appended.deny === undefined ? reviewLine(ids) : text;
    const sent = await $.prompt.submit({ text: prompt, asUser: true });

    return sent.drop === undefined ? undefined : `The comments were not sent: ${sent.drop}`;
  } catch (error) {
    return `Could not send the comments: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// Submits the parcels as one message, and hands each the reason it was not sent.
async function submit($: EngineInterface, parcels: readonly Parcel[]) {
  const failure = await trySubmit(
    $,
    parcels.map((p) => p.text).join("\n\n"),
    parcels.flatMap((p) => p.ids),
  );

  if (failure !== undefined) {
    await Promise.all(parcels.map((p) => p.onFailure(failure)));
  }
}

// Mid-turn, a parcel sent `now` is queued for the next tool result, and a
// review for the turn's end.
export async function deliver($: EngineInterface, parcel: Parcel, mode: "review" | "now") {
  if (isMainTurnRunning) {
    if (mode === "now") {
      outbox = [...outbox, parcel];
    } else {
      held = [...held, parcel];
    }
    return;
  }

  await submit($, [parcel]);
}

export const trackTurnStart: Hook<"turn.start"> = async (_$, e, next) => {
  if (e.agentId === undefined) {
    isMainTurnRunning = true;
  } else {
    agentTurnsRunning += 1;
  }

  return next(e);
};

export const attachToToolResult: Hook<"tool.call"> = async (_$, e, next) => {
  const done = await next(e);

  // While a subagent runs, a tool result may be its, not Claude's.
  if (done.deny !== undefined || outbox.length === 0 || agentTurnsRunning > 0) {
    return done;
  }

  const delivered = outbox;
  outbox = [];

  return { ...done, context: [...(done.context ?? []), ...delivered.map((p) => p.text)] };
};

// What no tool result carried, and every review held, goes out as a prompt
// once the main turn ends.
// Not awaited: the prompt waits for Claude to be idle, after this hook.
export const flushAtTurnEnd: Hook<"turn.complete"> = async ($, e, next) => {
  const done = await next(e);

  if (e.agentId !== undefined) {
    agentTurnsRunning = Math.max(0, agentTurnsRunning - 1);
    return done;
  }

  isMainTurnRunning = false;

  if (outbox.length > 0 || held.length > 0) {
    const left = [...outbox, ...held];
    outbox = [];
    held = [];
    void submit($, left);
  }

  return done;
};
