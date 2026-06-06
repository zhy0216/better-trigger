/* =============================================================================
   @better-trigger/server — run reporting + control routes.
   Worker reporting: steps / suspend / wait-for-run / batch-trigger / complete /
   fail / logs. Dashboard control: cancel / retry.
   See docs/backend-contract.md §3.2–3.7, §4, §5.
   ============================================================================= */
import { Hono } from 'hono';
import type {
  BatchTriggerStepRequest,
  BatchTriggerStepResponse,
  CompleteRunRequest,
  FailRunRequest,
  FailRunResponse,
  OkResponse,
  ReportLogsRequest,
  ReportStepRequest,
  RetryRunResponse,
  SuspendRequest,
  SuspendResponse,
  WaitForRunRequest,
  WaitForRunResponse,
} from '@better-trigger/core';
import {
  appendLogs,
  batchTriggerStep,
  cancelRun,
  completeRun,
  failRun,
  HttpError,
  reportStep,
  retryRun,
  suspend,
  waitForRun,
} from '../engine/runs';
import { assertArray, assertString, MAX_LOGS_PER_REQUEST } from '../validate';

export function runRoutes(): Hono {
  const app = new Hono();

  /* --------------------------------------------------------- steps */
  app.post('/runs/:id/steps', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json<ReportStepRequest>();
    await reportStep({
      runId: id,
      seq: body.seq,
      kind: body.kind,
      label: body.label,
      status: body.status,
      output: body.output,
      error: body.error,
      attempt: body.attempt,
      startedAt: body.startedAt,
      finishedAt: body.finishedAt,
      workerId: body.workerId,
    });
    const res: OkResponse = { ok: true };
    return c.json(res);
  });

  /* ------------------------------------------------------- suspend */
  app.post('/runs/:id/suspend', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json<SuspendRequest>();
    const { resumed } = await suspend({
      runId: id,
      seq: body.seq,
      label: body.label,
      kind: body.kind,
      resumeAt: body.resumeAt,
      workerId: body.workerId,
    });
    const res: SuspendResponse = { ok: true, resumed };
    return c.json(res);
  });

  /* -------------------------------------------------- wait-for-run */
  app.post('/runs/:id/wait-for-run', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json<WaitForRunRequest>();
    const { childRunId } = await waitForRun({
      runId: id,
      seq: body.seq,
      label: body.label,
      taskId: body.taskId,
      payload: body.payload,
      options: body.options,
      workerId: body.workerId,
    });
    const res: WaitForRunResponse = { childRunId };
    return c.json(res);
  });

  /* ------------------------------------------------- batch-trigger */
  app.post('/runs/:id/batch-trigger', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json<BatchTriggerStepRequest>();
    assertArray(body.items, 'items');
    for (const item of body.items) {
      assertString((item as { taskId?: unknown })?.taskId, 'item.taskId');
    }
    const { runIds } = await batchTriggerStep({
      runId: id,
      seq: body.seq,
      label: body.label,
      items: body.items,
      workerId: body.workerId,
    });
    const res: BatchTriggerStepResponse = { runIds };
    return c.json(res);
  });

  /* ------------------------------------------------------ complete */
  app.post('/runs/:id/complete', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json<CompleteRunRequest>();
    await completeRun({ runId: id, output: body.output, workerId: body.workerId });
    const res: OkResponse = { ok: true };
    return c.json(res);
  });

  /* ---------------------------------------------------------- fail */
  app.post('/runs/:id/fail', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json<FailRunRequest>();
    const result = await failRun({
      runId: id,
      error: body.error,
      stepSeq: body.stepSeq,
      retry: body.retry,
      abort: body.abort,
      workerId: body.workerId,
    });
    const res: FailRunResponse = {
      ok: true,
      willRetry: result.willRetry,
      ...(result.nextAttemptAt ? { nextAttemptAt: result.nextAttemptAt } : {}),
    };
    return c.json(res);
  });

  /* ---------------------------------------------------------- logs */
  app.post('/runs/:id/logs', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json<ReportLogsRequest>();
    const logs = body.logs ?? [];
    assertArray(logs, 'logs');
    if (logs.length > MAX_LOGS_PER_REQUEST) {
      throw new HttpError(
        400,
        'bad_request',
        `too many logs in one request (max ${MAX_LOGS_PER_REQUEST})`,
      );
    }
    await appendLogs(id, logs);
    const res: OkResponse = { ok: true };
    return c.json(res);
  });

  /* -------------------------------------------------------- cancel */
  app.post('/runs/:id/cancel', async (c) => {
    const id = c.req.param('id');
    await cancelRun(id);
    const res: OkResponse = { ok: true };
    return c.json(res);
  });

  /* --------------------------------------------------------- retry */
  app.post('/runs/:id/retry', async (c) => {
    const id = c.req.param('id');
    const { runId } = await retryRun(id);
    const res: RetryRunResponse = { runId };
    return c.json(res);
  });

  return app;
}
