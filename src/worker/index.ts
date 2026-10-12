/**
 * The Worker: a Hono app under /api, static assets for everything else.
 *
 * Route map (all responses JSON unless noted):
 *   GET    /api/health                      open   deploy-verification contract
 *   GET    /api/state                       open   bootstrap: agents + handshake + admin flags
 *   POST   /api/connect                     admin  start a Manyfold handshake
 *   POST   /api/connect/:id/poll            admin  poll it (2s cadence from the browser)
 *   DELETE /api/connect/:id                 admin  cancel it
 *   GET    /api/agents                      admin  connected agents (never tokens)
 *   POST   /api/agents/:agentId/verify      admin  re-run the non-billing auth probe
 *   DELETE /api/agents/:agentId             admin  disconnect + drop its conversation
 *   GET    /api/agents/:agentId/messages    admin  chat history
 *   DELETE /api/agents/:agentId/messages    admin  reset the conversation
 *   POST   /api/agents/:agentId/chat        admin  one chat turn (text/event-stream)
 *
 *   GET    /api/issues/latest?before=DATE   open   newest published issue on or before DATE
 *   GET    /api/issues                      open   published issues, newest first (archive)
 *   GET    /api/issues/:date                open   one published issue
 *   POST   /api/subscribe                   open   join the email list (throttled)
 *   POST   /api/feedback                    open   "was this issue useful" (throttled)
 *   POST   /api/reports                     open   "report a problem" (throttled)
 *   GET    /api/admin/issues                admin  every issue, drafts included
 *   PUT    /api/admin/issues/:date          admin  validate and store an issue, as draft or published
 *   GET    /api/admin/issues/:date          admin  one issue in any status (draft preview)
 *   POST   /api/admin/issues/:date/status   admin  publish or unpublish
 *   GET    /api/admin/pipeline              admin  writer and review agents, recent runs
 *   PUT    /api/admin/pipeline/agent        admin  choose the writer or the review agent
 *   GET    /api/admin/pipeline/sources      admin  read feeds and a few sources (no agent, free)
 *   GET    /api/admin/pipeline/runs/:id     admin  one run report
 *   POST   /api/admin/pipeline/run          admin  run the pipeline now (billed; needs confirm)
 *
 * The scheduled handler runs the pipeline daily at 19:30 UTC, and again at 20:30 UTC only if
 * that run failed; it only saves drafts.
 *
 * "admin" routes require the x-admin-password header — but only when the
 * ADMIN_PASSWORD secret is set. Without it the app is open, which is what makes
 * zero-config deploys work; set the secret before sharing the URL.
 */

import { Hono } from 'hono';
import type { AppState } from '../shared/types';
import { HttpError, type Env } from './types';
import { ensureSchema } from './db';
import { ConfigError, safeEqual } from './crypto';
import { A2AError } from './a2a';
import {
  cancelConnect,
  disconnectAgent,
  getConnectSession,
  listConnectedAgents,
  pollConnect,
  startConnect,
  verifyAgent,
} from './connect';
import { getConversation, handleChatTurn, resetConversation } from './chat';
import { IssueValidationError } from '../shared/issue';
import { getAnyIssue, getIssue, getLatestIssue, listAllIssues, listIssues, saveIssue, seedSampleIssue, setIssueStatus } from './issues';
import { RETRY_CRON, checkSources, getRun, listRuns, retryIfFailed, reviewerAgentId, runPipeline, setReviewerAgent, setWriterAgent, writerAgentId } from './pipeline/run';
import { clientKey, recordFeedback, recordReport, subscribe } from './public';
import { stripBase } from '../shared/base';

const SERVICE = 'cloudflare-worker-starter';

const app = new Hono<{ Bindings: Env }>();

/* ───────── middleware ───────── */

app.use('/api/*', async (c, next) => {
  await ensureSchema(c.env.DB);
  await next();
});

// Same-origin check on every mutation: browsers always send Origin on cross-site
// POSTs, so this shuts down CSRF without cookies or tokens.
app.use('/api/*', async (c, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)) {
    const origin = c.req.header('origin');
    if (!origin) {
      throw new HttpError(403, 'origin_required', 'Mutation requests must include a same-origin Origin header.');
    }
    if (origin !== new URL(c.req.url).origin) {
      throw new HttpError(403, 'invalid_origin', 'Cross-origin requests are not allowed.');
    }
  }
  await next();
});

const adminPassword = (env: Env): string | null => {
  const value = (env.ADMIN_PASSWORD ?? '').trim();
  return value.length > 0 ? value : null;
};

const adminHeaderOk = (c: { env: Env; req: { header: (name: string) => string | undefined } }): boolean => {
  const required = adminPassword(c.env);
  if (!required) return true;
  return safeEqual(c.req.header('x-admin-password') ?? '', required);
};

// The reader's routes are the site itself, so they stay open: reading published issues
// (read-only, cacheable, no agent calls, no credentials) and three throttled,
// strictly validated writes. None of them touches agents or secrets.
const isReaderRoute = (method: string, path: string): boolean =>
  (method === 'GET' && (path === '/api/issues' || path.startsWith('/api/issues/'))) ||
  (method === 'POST' && (path === '/api/subscribe' || path === '/api/feedback' || path === '/api/reports'));

// Everything else except /api/health and /api/state needs the password (when one is set).
app.use('/api/*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (path !== '/api/health' && path !== '/api/state' && !isReaderRoute(c.req.method, path) && !adminHeaderOk(c)) {
    throw new HttpError(401, 'admin_password_invalid', 'This deployment requires the admin password.');
  }
  await next();
});

/* ───────── error mapping ───────── */

app.onError((error, c) => {
  if (error instanceof HttpError) {
    return c.json({ error: { code: error.code, message: error.message } }, error.status as 400);
  }
  if (error instanceof IssueValidationError) {
    return c.json({ error: { code: 'invalid_issue', message: error.message } }, 400);
  }
  if (error instanceof ConfigError) {
    return c.json({ error: { code: 'misconfigured', message: error.message } }, 400);
  }
  if (error instanceof A2AError) {
    return error.retryable
      ? c.json({ error: { code: 'manyfold_unavailable', message: error.message } }, 502)
      : c.json({ error: { code: 'manyfold_rejected', message: error.message } }, 400);
  }
  console.error('unhandled', error);
  return c.json({ error: { code: 'internal', message: 'Something went wrong.' } }, 500);
});

/* ───────── routes ───────── */

app.get('/api/health', (c) =>
  c.json({ status: 'ok', service: SERVICE, time: new Date().toISOString() }),
);

app.get('/api/state', async (c) => {
  const [session, agents] = await Promise.all([
    getConnectSession(c.env),
    listConnectedAgents(c.env),
  ]);
  const state: AppState = {
    service: SERVICE,
    adminRequired: adminPassword(c.env) !== null,
    adminOk: adminHeaderOk(c),
    connect: { session },
    agents,
  };
  return c.json(state);
});

app.post('/api/connect', async (c) => {
  const session = await startConnect(c.env, c.req.url);
  return c.json({ connect: session }, 201);
});

app.post('/api/connect/:connectId/poll', async (c) => {
  const outcome = await pollConnect(c.env, c.req.param('connectId'));
  return c.json(outcome);
});

app.delete('/api/connect/:connectId', async (c) => {
  await cancelConnect(c.env, c.req.param('connectId'));
  return c.json({ ok: true });
});

app.get('/api/agents', async (c) => c.json({ agents: await listConnectedAgents(c.env) }));

app.post('/api/agents/:agentId/verify', async (c) =>
  c.json({ agent: await verifyAgent(c.env, c.req.param('agentId')) }),
);

app.delete('/api/agents/:agentId', async (c) => {
  await disconnectAgent(c.env, c.req.param('agentId'));
  return c.json({ ok: true });
});

app.get('/api/agents/:agentId/messages', async (c) =>
  c.json(await getConversation(c.env, c.req.param('agentId'))),
);

app.delete('/api/agents/:agentId/messages', async (c) => {
  await resetConversation(c.env, c.req.param('agentId'));
  return c.json({ ok: true });
});

app.post('/api/agents/:agentId/chat', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { message?: unknown } | null;
  if (!body || typeof body.message !== 'string') {
    throw new HttpError(400, 'bad_request', 'Body must be JSON with a string "message".');
  }
  return handleChatTurn({
    env: c.env,
    agentId: c.req.param('agentId'),
    message: body.message,
    waitUntil: (promise) => c.executionCtx.waitUntil(promise),
  });
});

/* ───────── reader ───────── */

const CACHE = 'public, max-age=60';

app.get('/api/issues/latest', async (c) => {
  await seedSampleIssue(c.env);
  c.header('cache-control', CACHE);
  return c.json(await getLatestIssue(c.env, c.req.query('before') ?? null));
});

app.get('/api/issues', async (c) => {
  await seedSampleIssue(c.env);
  c.header('cache-control', CACHE);
  return c.json({ issues: await listIssues(c.env) });
});

app.get('/api/issues/:date', async (c) => {
  await seedSampleIssue(c.env);
  c.header('cache-control', CACHE);
  return c.json(await getIssue(c.env, c.req.param('date')));
});

const readBody = async (c: { req: { json: () => Promise<unknown> } }) =>
  (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
const client = (c: { env: Env; req: { header: (name: string) => string | undefined } }) =>
  clientKey(c.env, c.req.header('cf-connecting-ip'));

app.post('/api/subscribe', async (c) => {
  await subscribe(c.env, await readBody(c), await client(c));
  return c.json({ ok: true });
});

app.post('/api/feedback', async (c) => {
  await recordFeedback(c.env, await readBody(c), await client(c));
  return c.json({ ok: true });
});

app.post('/api/reports', async (c) => {
  await recordReport(c.env, await readBody(c), await client(c));
  return c.json({ ok: true });
});

/* ───────── admin: issues ───────── */

app.get('/api/admin/issues', async (c) => c.json({ issues: await listAllIssues(c.env) }));

app.put('/api/admin/issues/:date', async (c) => {
  const body = await readBody(c);
  const status = body?.status === 'published' ? 'published' : 'draft';
  const issue = await saveIssue(c.env, c.req.param('date'), body?.issue, status);
  return c.json({ ok: true, date: issue.date, status });
});

app.get('/api/admin/issues/:date', async (c) => c.json(await getAnyIssue(c.env, c.req.param('date'))));

app.post('/api/admin/issues/:date/status', async (c) => {
  const body = await readBody(c);
  const status = body?.status === 'published' ? 'published' : 'draft';
  await setIssueStatus(c.env, c.req.param('date'), status);
  return c.json({ ok: true, status });
});

/* ───────── admin: pipeline ───────── */

app.get('/api/admin/pipeline', async (c) =>
  c.json({ writerAgentId: await writerAgentId(c.env), reviewerAgentId: await reviewerAgentId(c.env), runs: await listRuns(c.env) }),
);

// The review agent must stay independent of the writer, so one agent cannot be both.
app.put('/api/admin/pipeline/agent', async (c) => {
  const body = await readBody(c);
  const agentId = typeof body?.agentId === 'string' ? body.agentId : '';
  const role = body?.role === 'reviewer' ? 'reviewer' : 'writer';
  const agents = await listConnectedAgents(c.env);
  if (!agents.some((a) => a.agentId === agentId)) throw new HttpError(400, 'bad_request', 'That agent is not connected.');
  const other = role === 'reviewer' ? await writerAgentId(c.env) : await reviewerAgentId(c.env);
  if (agentId === other) throw new HttpError(400, 'bad_request', 'The writer and the review agent must be different agents.');
  await (role === 'reviewer' ? setReviewerAgent : setWriterAgent)(c.env, agentId);
  return c.json({ ok: true });
});

// Free: reads the feeds and a few sources, never calls an agent.
app.get('/api/admin/pipeline/sources', async (c) => c.json(await checkSources(c.env)));

app.get('/api/admin/pipeline/runs/:id', async (c) => {
  const run = await getRun(c.env, c.req.param('id'));
  if (!run) throw new HttpError(404, 'not_found', 'No such run.');
  return c.json(run);
});

// A manual run makes four billed agent turns, so it must be asked for explicitly.
app.post('/api/admin/pipeline/run', async (c) => {
  const body = await readBody(c);
  if (body?.confirm !== true) throw new HttpError(400, 'confirm_required', 'A run makes billed agent calls; send {"confirm": true}.');
  const issueDate = typeof body.issueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.issueDate) ? body.issueDate : undefined;
  return c.json(await runPipeline(c.env, { trigger: 'manual', issueDate }));
});

app.all('/api/*', () => {
  throw new HttpError(404, 'not_found', 'No such API route.');
});

// Anything else that reaches the Worker is a static asset (or the SPA fallback).
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

// The shared host sends /ai-news/api/...; routes are written without the base path.
// Anything else (static files, pages) keeps its path for the assets binding.
function withoutBase(request: Request): Request {
  const url = new URL(request.url);
  const path = stripBase(url.pathname);
  if (path === url.pathname || !path.startsWith('/api/')) return request;
  url.pathname = path;
  return new Request(url, request);
}

export default {
  fetch: (request, env, ctx) => app.fetch(withoutBase(request), env, ctx),
  // The daily pipeline and its one retry (wrangler.jsonc triggers.crons). Drafts only.
  scheduled(controller, env, ctx) {
    const at = new Date(controller.scheduledTime);
    ctx.waitUntil(controller.cron === RETRY_CRON ? retryIfFailed(env, at) : runPipeline(env, { trigger: 'cron', at }));
  },
} satisfies ExportedHandler<Env>;
