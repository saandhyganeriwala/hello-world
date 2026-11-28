import {
  claimNext,
  complete,
  fail,
  enqueue,
  type ClaimedJob,
} from "./queue.server";
import { processConversationTurn } from "./turn.server";
import {
  runCheckoutDigestJob,
  runCleanup,
  runSummaryJob,
  scheduleDueUpdates,
} from "./scheduled.server";

/**
 * In-process background worker: runs queued jobs and the scheduler. Started once from entry.server.
 * Set WORKER_ENABLED=false on web-only instances if you run a separate worker process later.
 */
const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? "4");
const SCHEDULER_INTERVAL_MS = 5 * 60 * 1000;

declare global {
  // eslint-disable-next-line no-var
  var __storemateWorker: { started: boolean } | undefined;
}

export function startWorker() {
  if (process.env.WORKER_ENABLED === "false" || process.env.NODE_ENV === "test")
    return;
  if (globalThis.__storemateWorker?.started) return;
  globalThis.__storemateWorker = { started: true };

  for (let i = 0; i < CONCURRENCY; i++) void loop();

  const tick = async () => {
    try {
      await scheduleDueUpdates();
    } catch (error) {
      console.error("[scheduler] failed", error);
    }
  };
  setTimeout(tick, 10_000);
  setInterval(tick, SCHEDULER_INTERVAL_MS);
  setInterval(
    () => void enqueue("cleanup", {}).catch(() => undefined),
    24 * 3600 * 1000,
  );
  console.info(`[worker] started with ${CONCURRENCY} loops`);
}

async function loop() {
  for (;;) {
    let job: ClaimedJob | null = null;
    try {
      job = await claimNext();
    } catch (error) {
      console.error("[worker] claim failed", error);
    }
    if (!job) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }
    try {
      await runJob(job);
      await complete(job.id);
    } catch (error) {
      const retrying = await fail(job, error).catch(() => false);
      console.error(
        `[worker] job ${job.kind} ${job.id} failed${retrying ? " (will retry)" : ""}`,
        error,
      );
    }
  }
}

export async function runJob(job: ClaimedJob) {
  switch (job.kind) {
    case "inbound":
      if (job.conversationKey)
        await processConversationTurn(job.conversationKey);
      return;
    case "summary":
      await runSummaryJob(String(job.payload.shopId));
      return;
    case "checkout_digest":
      await runCheckoutDigestJob(String(job.payload.shopId));
      return;
    case "cleanup":
      await runCleanup();
      return;
    default:
      console.warn(`[worker] unknown job kind ${job.kind}`);
  }
}
