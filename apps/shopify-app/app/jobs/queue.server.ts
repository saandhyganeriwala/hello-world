import type { Prisma } from "@prisma/client";
import db from "../db.server";

/**
 * A small Postgres-backed job queue (no Redis needed).
 * - Jobs with the same conversationKey never run at the same time and run in creation order.
 * - Claiming uses FOR UPDATE SKIP LOCKED so several workers can share the table safely.
 * - Failed jobs retry with backoff up to MAX_ATTEMPTS.
 */
export type JobKind =
  | "inbound"
  | "media_batch"
  | "approval"
  | "summary"
  | "checkout_digest"
  | "cleanup";

const MAX_ATTEMPTS = 4;
const STALE_RUNNING_MS = 10 * 60 * 1000;

export async function enqueue(
  kind: JobKind,
  payload: Prisma.InputJsonValue,
  opts: { conversationKey?: string | null; runAt?: Date } = {},
) {
  return db.job.create({
    data: {
      kind,
      payload,
      conversationKey: opts.conversationKey ?? null,
      runAt: opts.runAt ?? new Date(),
    },
  });
}

export interface ClaimedJob {
  id: string;
  kind: JobKind;
  conversationKey: string | null;
  payload: Record<string, unknown>;
  attempts: number;
}

/** Claims the next runnable job, skipping conversations that already have a job running. */
export async function claimNext(): Promise<ClaimedJob | null> {
  // Recover jobs left "running" by a crashed process.
  await db.job.updateMany({
    where: {
      status: "running",
      startedAt: { lt: new Date(Date.now() - STALE_RUNNING_MS) },
    },
    data: { status: "queued" },
  });

  const rows = await db.$queryRaw<ClaimedJob[]>`
    UPDATE "Job" SET status = 'running', "startedAt" = now(), attempts = attempts + 1
    WHERE id = (
      SELECT j.id FROM "Job" j
      WHERE j.status = 'queued' AND j."runAt" <= now()
        AND (
          j."conversationKey" IS NULL OR (
            NOT EXISTS (
              SELECT 1 FROM "Job" r WHERE r."conversationKey" = j."conversationKey" AND r.status = 'running'
            )
            AND NOT EXISTS (
              SELECT 1 FROM "Job" e WHERE e."conversationKey" = j."conversationKey" AND e.status = 'queued'
                AND e."createdAt" < j."createdAt"
            )
          )
        )
      ORDER BY j."runAt", j."createdAt"
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, kind, "conversationKey", payload, attempts`;
  return rows[0] ?? null;
}

export async function complete(jobId: string) {
  await db.job.update({
    where: { id: jobId },
    data: { status: "done", finishedAt: new Date() },
  });
}

export async function fail(job: ClaimedJob, error: unknown) {
  const message =
    error instanceof Error
      ? `${error.message}\n${error.stack ?? ""}`
      : String(error);
  const retry = job.attempts < MAX_ATTEMPTS;
  await db.job.update({
    where: { id: job.id },
    data: {
      status: retry ? "queued" : "failed",
      lastError: message.slice(0, 4000),
      runAt: retry
        ? new Date(Date.now() + 2 ** job.attempts * 5000)
        : undefined,
      finishedAt: retry ? null : new Date(),
    },
  });
  return retry;
}
