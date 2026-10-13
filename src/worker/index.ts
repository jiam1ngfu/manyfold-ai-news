/**
 * The Worker: a Hono app under /api, static assets for everything else.
 *
 * Route map (all responses JSON unless noted):
 *   GET    /api/health                      open   deploy-verification contract
 *   GET    /api/state                       open   bootstrap: admin flags; agents and handshake for the admin only
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
 *   GET    /api/issues/corrections          open   the public corrections log
 *   GET    /api/issues/:date                open   one published issue
 *   POST   /api/subscribe                   open   join the email list; sends the confirmation, or a
 *                                                  confirmed subscriber's sign-in link (throttled)
 *   POST   /api/subscribe/confirm           open   the confirmation link (signed token)
 *   POST   /api/subscribe/signin            open   the sign-in link: this browser's ask key (signed token)
 *   POST   /api/unsubscribe                 open   the unsubscribe link and one-click header (signed token)
 *   POST   /api/ask                         open   a subscriber's own question (ask key; queued, billed)
 *   GET    /api/ask/:id                     open   that question's checked answer, once ready
 *   POST   /api/feedback                    open   "was this issue useful" (throttled)
 *   POST   /api/reports                     open   "report a problem", with an optional note (throttled)
 *   POST   /api/events                      open   view / finish / share counters, per day (throttled)
 *   POST   /api/survey                      open   a subscriber's "would you miss it" answer (ask key)
 *   POST   /api/webhooks/resend             signed bounces and complaints from the mail provider
 *   GET    /api/admin/issues                admin  every issue, drafts included
 *   PUT    /api/admin/issues/:date          admin  validate and store an issue, as draft or published
 *   GET    /api/admin/issues/:date          admin  one issue in any status (draft preview)
 *   POST   /api/admin/issues/:date/status   admin  publish or unpublish
 *   POST   /api/admin/issues/:date/correct  admin  correct or withdraw a story or brief in a published issue
 *   POST   /api/admin/issues/:date/check    admin  the owner's check: clean, errors, or not checked
 *   GET    /api/admin/quality               admin  launch gate, open reports, corrections
 *   GET    /api/admin/reports?status=       admin  readers' reports with their notes
 *   POST   /api/admin/reports/:id           admin  mark a report resolved or open
 *   GET    /api/admin/stats                 admin  reading counts per issue, the gate's reader measures
 *   GET    /api/admin/pipeline              admin  agents, automation settings, run budget, recent runs
 *   PUT    /api/admin/pipeline/settings     admin  auto-publish, alert address, daily run limit
 *   POST   /api/admin/alerts/test           admin  send a test alert to the owner
 *   PUT    /api/admin/pipeline/agent        admin  choose the writer, review or answer agent
 *   GET    /api/admin/pipeline/sources      admin  read feeds and a few sources (no agent, free)
 *   GET    /api/admin/pipeline/runs/:id     admin  one run report
 *   POST   /api/admin/pipeline/run          admin  run the pipeline now (billed; needs confirm; daily limit)
 *   GET    /api/admin/email                 admin  provider, subscriber counts, deliveries (no addresses)
 *   GET    /api/admin/email/preview         admin  an issue rendered as the email
 *   POST   /api/admin/email/test            admin  send one issue email to one address
 *   GET    /api/admin/ask                   admin  readers' questions: limits, daily counts, recent ones
 *   PUT    /api/admin/ask                   admin  pause or resume asking, set the daily limit
 *
 * Everything else is a page: index.html with that page's tags and status (pages.ts), the
 * sitemap, or a static file.
 *
 * The scheduled handler runs the pipeline daily at 19:30 UTC, and again at 20:30 UTC only if
 * that run failed (then prunes old data); a run publishes what passes its checks unless the
 * owner turned auto-publish off.
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
import { A2AError, safeErrorText } from './a2a';
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
import {
  RETRY_CRON,
  assertRunBudget,
  autoPublish,
  checkSources,
  getRun,
  listRuns,
  retryIfFailed,
  reviewerAgentId,
  runBudget,
  runPipeline,
  setPipelineSettings,
  setReviewerAgent,
  setWriterAgent,
  writerAgentId,
} from './pipeline/run';
import { clientKey, confirmSubscription, isEmail, recordEvent, recordFeedback, recordReport, recordSurvey, signIn, subscribe, unsubscribe } from './public';
import { deliverDue, emailStatus, previewIssueEmail, sendLinkEmail, sendTest } from './email/deliver';
import { answererAgentId, askOverview, askQuestion, getQuestion, processQuestion, setAnswererAgent, setAskSettings, type AskMessage } from './ask/questions';
import { BASE_PATH, stripBase } from '../shared/base';
import { adminUrl, alertAddress, sendAlert, setAlertAddress } from './alerts';
import { correctIssue, listCorrections, listReports, qualityOverview, setIssueCheck, setReportStatus } from './quality';
import { statsOverview } from './stats';
import { handleResendWebhook } from './email/webhook';
import { pruneOldData } from './retention';
import { renderPage, renderSitemap } from './pages';
import { turnstileOn } from './turnstile';

const SERVICE = 'ai-in-5';
const EMAIL_CRON = '*/15 * * * *';

const app = new Hono<{ Bindings: Env }>();

/** Where the site is when SITE_URL is not set (local dev): this host, below the base path. */
const siteFromRequest = (url: string): string => `${new URL(url).origin}${BASE_PATH}`;

/* ───────── middleware ───────── */

app.use('/api/*', async (c, next) => {
  await ensureSchema(c.env.DB);
  await next();
});

// Same-origin check on every mutation: browsers always send Origin on cross-site
// POSTs, so this shuts down CSRF without cookies or tokens. Two exceptions, both sent
// server to server without an Origin: the mail provider's one-click List-Unsubscribe
// POST, which acts only on the signed token in its URL, and its bounce webhook, which
// is rejected unless signed with RESEND_WEBHOOK_SECRET.
const SERVER_TO_SERVER = new Set(['/api/unsubscribe', '/api/webhooks/resend']);
app.use('/api/*', async (c, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method) && !SERVER_TO_SERVER.has(new URL(c.req.url).pathname)) {
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
// (read-only, cacheable, no agent calls, no credentials) and throttled, strictly
// validated writes. None of them calls an agent itself: a subscriber's question is
// stored and queued, and the queue consumer makes the one billed turn. The only secret
// any of them uses is the mail provider key, to email the address just submitted its
// confirmation or sign-in link.
const READER_POSTS = new Set([
  '/api/subscribe',
  '/api/subscribe/confirm',
  '/api/subscribe/signin',
  '/api/unsubscribe',
  '/api/feedback',
  '/api/reports',
  '/api/events',
  '/api/survey',
  '/api/ask',
]);
const isReaderRoute = (method: string, path: string): boolean =>
  (method === 'GET' && (path === '/api/issues' || path.startsWith('/api/issues/') || path.startsWith('/api/ask/'))) ||
  (method === 'POST' && READER_POSTS.has(path));

// Everything else except /api/health, /api/state and the signed webhook needs the
// password (when one is set).
app.use('/api/*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  const open = path === '/api/health' || path === '/api/state' || path === '/api/webhooks/resend' || isReaderRoute(c.req.method, path);
  if (!open && !adminHeaderOk(c)) {
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

// Open so the console can tell whether to ask for the password; which agents are
// connected is the owner's business, so only the admin sees them.
app.get('/api/state', async (c) => {
  const adminOk = adminHeaderOk(c);
  const [session, agents] = adminOk ? await Promise.all([getConnectSession(c.env), listConnectedAgents(c.env)]) : [null, []];
  const state: AppState = {
    service: SERVICE,
    adminRequired: adminPassword(c.env) !== null,
    adminOk,
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

app.get('/api/issues/corrections', async (c) => {
  c.header('cache-control', CACHE);
  return c.json({ corrections: await listCorrections(c.env) });
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
  const link = await subscribe(c.env, await readBody(c), await client(c), c.req.header('cf-connecting-ip'));
  // Sent after the response, so the reader never waits on the mail provider, and the
  // response is the same whichever email (if any) goes out.
  if (link) c.executionCtx.waitUntil(sendLinkEmail(c.env, link.kind, link.email, link.lang, siteFromRequest(c.req.url)));
  return c.json({ ok: true });
});

app.post('/api/subscribe/confirm', async (c) => c.json({ ok: true, ...(await confirmSubscription(c.env, await readBody(c), await client(c))) }));

app.post('/api/subscribe/signin', async (c) => c.json({ ok: true, ...(await signIn(c.env, await readBody(c), await client(c))) }));

// Both the page's button (JSON body) and the mail provider's one-click POST (form body,
// token in the URL) land here.
app.post('/api/unsubscribe', async (c) => {
  const body = c.req.header('content-type')?.includes('application/json') ? await readBody(c) : null;
  await unsubscribe(c.env, body, c.req.query('t') ?? null, await client(c));
  return c.json({ ok: true });
});

app.post('/api/ask', async (c) => c.json(await askQuestion(c.env, await readBody(c), await client(c))));

app.get('/api/ask/:id', async (c) => c.json(await getQuestion(c.env, c.req.param('id'))));

app.post('/api/feedback', async (c) => {
  await recordFeedback(c.env, await readBody(c), await client(c));
  return c.json({ ok: true });
});

app.post('/api/reports', async (c) => {
  await recordReport(c.env, await readBody(c), await client(c), (work) => c.executionCtx.waitUntil(work));
  return c.json({ ok: true });
});

app.post('/api/events', async (c) => {
  await recordEvent(c.env, await readBody(c), await client(c));
  return c.json({ ok: true });
});

app.post('/api/survey', async (c) => {
  await recordSurvey(c.env, await readBody(c), await client(c));
  return c.json({ ok: true });
});

app.post('/api/webhooks/resend', async (c) => {
  const { status } = await handleResendWebhook(c.env, c.req.raw);
  return c.json({ ok: status === 200 }, status as 200);
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

app.post('/api/admin/issues/:date/correct', async (c) => {
  const issue = await correctIssue(c.env, c.req.param('date'), await readBody(c));
  return c.json({ ok: true, corrections: issue.corrections ?? [] });
});

app.post('/api/admin/issues/:date/check', async (c) => {
  await setIssueCheck(c.env, c.req.param('date'), await readBody(c));
  return c.json({ ok: true });
});

/* ───────── admin: quality and stats ───────── */

app.get('/api/admin/quality', async (c) => c.json(await qualityOverview(c.env)));

app.get('/api/admin/reports', async (c) => {
  const status = c.req.query('status');
  return c.json({ reports: await listReports(c.env, status === 'resolved' || status === 'all' ? status : 'open') });
});

app.post('/api/admin/reports/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id < 1) throw new HttpError(400, 'bad_request', 'No such report.');
  await setReportStatus(c.env, id, (await readBody(c))?.status);
  return c.json({ ok: true });
});

app.get('/api/admin/stats', async (c) => c.json(await statsOverview(c.env)));

/* ───────── admin: pipeline ───────── */

app.get('/api/admin/pipeline', async (c) =>
  c.json({
    writerAgentId: await writerAgentId(c.env),
    reviewerAgentId: await reviewerAgentId(c.env),
    answererAgentId: await answererAgentId(c.env),
    autoPublish: await autoPublish(c.env),
    alertEmail: await alertAddress(c.env),
    budget: await runBudget(c.env),
    runs: await listRuns(c.env),
  }),
);

app.put('/api/admin/pipeline/settings', async (c) => {
  const body = await readBody(c);
  await setPipelineSettings(c.env, body);
  if (typeof body?.alertEmail === 'string') {
    try {
      await setAlertAddress(c.env, body.alertEmail);
    } catch (error) {
      throw new HttpError(400, 'bad_request', error instanceof Error ? error.message : 'Invalid address.');
    }
  }
  return c.json({ ok: true, autoPublish: await autoPublish(c.env), alertEmail: await alertAddress(c.env), budget: await runBudget(c.env) });
});

app.post('/api/admin/alerts/test', async (c) => {
  const to = await alertAddress(c.env);
  if (!to) throw new HttpError(400, 'bad_request', 'Set an alert address first.');
  const sent = await sendAlert(c.env, {
    key: `test:${new Date().toISOString()}`,
    subject: 'test alert',
    lines: ['This is a test. Alerts reach this address when a scheduled run fails or publishes, a reader reports a problem, or an address bounces.'],
    link: { label: 'Open /admin', url: adminUrl(c.env, 'issues') },
  });
  return c.json({ ok: sent, error: sent ? undefined : 'The alert did not go out. Check that email sending is set up (/admin#email).' });
});

// Three roles, three different agents: the reviewer stays independent of the writer, and
// the answerer, which reads untrusted reader questions, shares nothing with either.
app.put('/api/admin/pipeline/agent', async (c) => {
  const body = await readBody(c);
  const agentId = typeof body?.agentId === 'string' ? body.agentId : '';
  const role = body?.role === 'reviewer' || body?.role === 'answerer' ? body.role : 'writer';
  const agents = await listConnectedAgents(c.env);
  if (!agents.some((a) => a.agentId === agentId)) throw new HttpError(400, 'bad_request', 'That agent is not connected.');
  const current = { writer: await writerAgentId(c.env), reviewer: await reviewerAgentId(c.env), answerer: await answererAgentId(c.env) };
  if (Object.entries(current).some(([r, id]) => r !== role && id === agentId)) {
    throw new HttpError(400, 'bad_request', 'The writer, the reviewer and the answerer must be three different agents.');
  }
  await ({ writer: setWriterAgent, reviewer: setReviewerAgent, answerer: setAnswererAgent } as const)[role](c.env, agentId);
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
  await assertRunBudget(c.env);
  // Manual runs always open a row (or are refused before billing), so this is never null.
  return c.json(await runPipeline(c.env, { trigger: 'manual', issueDate }));
});

/* ───────── admin: email ───────── */

app.get('/api/admin/email', async (c) =>
  c.json({
    ...(await emailStatus(c.env)),
    postalAddress: (c.env.EMAIL_POSTAL_ADDRESS ?? '').trim() || null,
    contactEmail: (c.env.CONTACT_EMAIL ?? '').trim() || null,
    webhook: Boolean((c.env.RESEND_WEBHOOK_SECRET ?? '').trim()),
    turnstile: turnstileOn(c.env),
  }),
);

const langParam = (value: unknown) => (value === 'zh' ? 'zh' : 'en');

app.get('/api/admin/email/preview', async (c) => {
  const date = c.req.query('date') ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'bad_request', 'date must be YYYY-MM-DD.');
  const preview = await previewIssueEmail(c.env, date, langParam(c.req.query('lang')), siteFromRequest(c.req.url));
  if (!preview) throw new HttpError(404, 'not_found', 'No issue for that date.');
  return c.json(preview);
});

app.post('/api/admin/email/test', async (c) => {
  const body = await readBody(c);
  const date = typeof body?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : '';
  const to = typeof body?.to === 'string' ? body.to.trim().toLowerCase() : '';
  if (!date || !isEmail(to)) throw new HttpError(400, 'bad_request', 'Send a date and a valid address.');
  return c.json(await sendTest(c.env, date, langParam(body?.lang), to));
});

/* ───────── admin: readers' questions ───────── */

app.get('/api/admin/ask', async (c) => c.json(await askOverview(c.env)));

app.put('/api/admin/ask', async (c) => {
  await setAskSettings(c.env, await readBody(c));
  return c.json(await askOverview(c.env));
});

app.all('/api/*', () => {
  throw new HttpError(404, 'not_found', 'No such API route.');
});

// Everything else: the sitemap, a static file, or a reader page with its own tags.
app.all('*', async (c) => {
  const path = stripBase(new URL(c.req.url).pathname);
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return c.env.ASSETS.fetch(c.req.raw);
  if (path === '/sitemap.xml') {
    await ensureSchema(c.env.DB);
    return renderSitemap(c.env, c.req.raw);
  }
  if (/\.[a-z0-9]+$/i.test(path)) return c.env.ASSETS.fetch(c.req.raw);
  try {
    await ensureSchema(c.env.DB);
    return await renderPage(c.env, c.req.raw, path);
  } catch (error) {
    // The page still works without its tags: the app loads its data itself.
    console.error('page tags failed', safeErrorText(error instanceof Error ? error.message : error));
    return c.env.ASSETS.fetch(c.req.raw);
  }
});

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
  // wrangler.jsonc triggers.crons: the daily pipeline, its one retry (followed by the
  // daily clean-up of old data), and the 15-minute email tick. Each cron is its own
  // invocation with its own limits.
  scheduled(controller, env, ctx) {
    const at = new Date(controller.scheduledTime);
    if (controller.cron === EMAIL_CRON) {
      // Counts only: addresses never reach the logs.
      ctx.waitUntil(
        ensureSchema(env.DB)
          .then(() => deliverDue(env, at))
          .then(async (tick) => {
            if (tick.due > 0) console.log('email tick', JSON.stringify(tick));
            if (tick.failed > 0) {
              await sendAlert(env, {
                key: `delivery:${at.toISOString().slice(0, 10)}`,
                subject: `${tick.failed} issue ${tick.failed === 1 ? 'email' : 'emails'} failed to send`,
                lines: ['Failed sends are retried on the next ticks, up to three attempts each. If this keeps happening, check the last error in /admin#email.'],
                link: { label: 'Open email', url: adminUrl(env, 'email') },
              });
            }
          }),
      );
    } else if (controller.cron === RETRY_CRON) {
      ctx.waitUntil(
        retryIfFailed(env, at)
          .then(() => pruneOldData(env, at))
          .then((pruned) => console.log('pruned', JSON.stringify(pruned))),
      );
    } else ctx.waitUntil(runPipeline(env, { trigger: 'cron', at }));
  },
  // Readers' questions, one per message (wrangler.jsonc queues). A thrown error asks the
  // queue to retry; processQuestion marks the question failed on its last attempt.
  async queue(batch, env) {
    await ensureSchema(env.DB);
    for (const message of batch.messages) {
      try {
        await processQuestion(env, message.body as AskMessage, message.attempts);
        message.ack();
      } catch {
        message.retry({ delaySeconds: 5 });
      }
    }
  },
} satisfies ExportedHandler<Env>;
