import type { EngineInterface, Hook } from "claude-code";

// What goes to Claude, and what to do when it does not arrive.
export type Parcel = {
  text: string;
  onFailure: (reason: string) => Promise<void>;
};

// A plugin's prompt reaches Claude only once it is idle. Mid-turn, comments
// sent now ride on the next tool result of the main loop instead.
let isMainTurnRunning = false;
let agentTurnsRunning = 0;
let outbox: Parcel[] = [];

// Submits `text` as the person's message; resolves why it was not sent, if it
// was not.
async function trySubmit($: EngineInterface, text: string) {
  try {
    const sent = await $.prompt.submit({ text, asUser: true });

    return sent.drop === undefined ? undefined : `The comments were not sent: ${sent.drop}`;
  } catch (error) {
    return `Could not send the comments: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// Submits the parcels as one message, and hands each the reason it was not sent.
async function submit($: EngineInterface, parcels: readonly Parcel[]) {
  const failure = await trySubmit($, parcels.map((p) => p.text).join("\n\n"));

  if (failure !== undefined) {
    await Promise.all(parcels.map((p) => p.onFailure(failure)));
  }
}

// A review waits for Claude to be idle; a parcel sent `now` mid-turn is queued
// for the next tool result instead.
export async function deliver($: EngineInterface, parcel: Parcel, mode: "review" | "now") {
  if (mode === "now" && isMainTurnRunning) {
    outbox = [...outbox, parcel];
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

// What no tool result carried goes out as a prompt once the main turn ends.
// Not awaited: the prompt waits for Claude to be idle, after this hook.
export const flushAtTurnEnd: Hook<"turn.complete"> = async ($, e, next) => {
  const done = await next(e);

  if (e.agentId !== undefined) {
    agentTurnsRunning = Math.max(0, agentTurnsRunning - 1);
    return done;
  }

  isMainTurnRunning = false;

  if (outbox.length > 0) {
    const left = outbox;
    outbox = [];
    void submit($, left);
  }

  return done;
};
