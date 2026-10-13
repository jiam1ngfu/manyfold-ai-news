# Working on this repository

Rules for anyone — human or AI agent — changing AI in 5. It grew from the Manyfold
Cloudflare Worker starter; these are the load-bearing walls.

## How deployment works

- **Deploys are manual, from `main`.** Production is the `manyfold-ai-news` Worker on the
  NetMind.AI Cloudflare account (`account_id` is pinned in `wrangler.jsonc`), routed at
  `app.manyfold.ai/ai-news`. Pushing to GitHub does not deploy: Workers Builds is not
  linked. From a clean checkout of `main`: `npm ci && npm run check && npm test && npm run
  build && npx wrangler deploy`. CI (`.github/workflows/ci.yml`) only checks; it never
  deploys and holds no credentials.
- The build step is load-bearing: `wrangler deploy` deploys the output that
  `vite build` writes to `dist/` (via the Cloudflare Vite plugin's deploy-config redirect).
  Never deploy without building first, and never remove the `build` script.
- After every deploy, verify it: `npm run smoke -- https://app.manyfold.ai/ai-news`
  (`GET /api/health` must return HTTP 200 JSON). The first request can return 530 while
  the route propagates; the smoke test waits.

## Invariants

1. **Keep `wrangler.jsonc` deployable.** `main`, `assets`, and the `DB` binding are read by
   the app. Never edit `database_id`: it points at production's data, and changing it
   orphans every issue and subscriber. Keep `assets.run_worker_first` sending page paths
   to the Worker (rule 13) and static files straight to the assets.
2. **Keep `GET /api/health` returning 200 JSON.** It is the deploy-verification contract for
   the smoke test.
3. **Evolve the database only through `SCHEMA` in `src/worker/db.ts`**, with
   `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`. Keep semicolons out of
   statement bodies (the splitter treats every `;` as a boundary). There is no migration
   step, and nothing may assume one.
4. **Never commit secrets.** New secrets get a commented entry in `.dev.vars.example` and an
   instruction to run `npx wrangler secret put NAME`. `.dev.vars` is git-ignored; keep it so.
5. **Respect the runtime split.** `src/worker/` runs in workerd only (no Node-built-ins),
   `src/app/` runs in the browser only, `src/shared/` must run in both.
6. **Preserve the credential-security invariants:**
   - the Manyfold device code and agent bearer tokens never appear in an API response, a log
     line, or the browser — they are AES-GCM sealed in D1 (`seal`/`unseal` in
     `src/worker/crypto.ts`);
   - connectivity checks use the non-billing `tasks/get` probe
     (`probeAgentAuth`), never `message/send` — a real turn bills the user;
   - agent-supplied URLs go through `validateA2AUrl` before use (SSRF guard);
   - error strings pass through `safeErrorText` before leaving the worker;
   - A2A `messageId`s are derived from stored rows, not random, so retries cannot
     double-bill (`src/worker/chat.ts`).
7. **Keep new routes behind the admin gate.** Any route added under `/api/` is protected by
   the `ADMIN_PASSWORD` middleware automatically — do not add exceptions beyond `/api/health`,
   `/api/state` and the reader routes without a reason as good as theirs. The reader routes
   are the public site itself (`isReaderRoute` in `src/worker/index.ts`): `GET /api/issues*`
   serves published issues only (read-only, cacheable, no agent calls, no credentials), and
   `POST /api/subscribe`, `/api/subscribe/confirm`, `/api/subscribe/signin`,
   `/api/unsubscribe`, `/api/ask`, `/api/feedback`, `/api/reports`, `/api/events` and
   `/api/survey` (and `GET /api/ask/:id`) validate strictly and are throttled per salted IP
   hash. A reader route must never call an agent or touch a secret itself, with these
   exceptions: `/api/subscribe` checks Turnstile (`TURNSTILE_SECRET_KEY`) and uses the mail
   provider key to send the address just submitted a rate-limited email (a confirmation if
   it is pending, a 30-minute sign-in link if it is already confirmed, the same response
   either way); `/api/ask` queues a confirmed subscriber's question for the answer agent
   (rule 12); `/api/reports` sends the owner an alert (rule 14). There are no reader
   accounts or passwords: a browser can ask once it holds an ask key, from the
   confirmation link, a sign-in link or any issue email.
   Two mutations are exempt from the same-origin check because they come server to server:
   `/api/unsubscribe` (the mail provider's one-click List-Unsubscribe POST; it acts only on
   the signed token in its URL) and `POST /api/webhooks/resend` (bounces and complaints; it
   is also outside the admin gate, and rejects anything not signed with
   `RESEND_WEBHOOK_SECRET`).
8. **Keep the reader honest.** Only `status = 'published'` issues reach readers, and every
   issue passes `validateIssue` (`src/shared/issue.ts`) before it is stored. A published
   issue changes only through `applyCorrection` (`/admin#quality`): a corrected story is
   marked with the owner's note, a withdrawn one leaves a notice, both are listed on the
   public corrections page and in the next issue email, and a correction counts as an error
   for the launch gate. Never edit a published story silently. The fictional
   sample issue is seeded into the local database under `npm run dev` only, never in a
   build. Issue text is rendered as React text (marks and citations are tokens, not HTML);
   images and logos are `<img>` with https or `data:image` sources only.
9. **The reader and the admin console stay separate.** `/admin` (issues, quality, stats,
   email, questions, agents) is reached by URL only and loads its own chunk and stylesheet (`src/app/App.tsx`,
   `styles.css`); the reader (`src/app/reader/`) follows `docs/design/` and never links to it.
10. **The pipeline publishes only what passed every check, and it bills.**
    `src/worker/pipeline/` runs daily from the cron trigger (19:30 UTC, one retry at 20:30
    only if that run failed) and on demand from `/admin#issues`. Each run makes four billed
    agent turns (pick, write and translate on the writer, review on the reviewer), plus at
    most one repair turn per step whose reply is not valid JSON even after `jsonrepair`
    (`jsonTurn`, messageId `<step>-fix`). Every `messageId` derives from the stored
    `pipeline_runs.id`, so a retried step cannot bill twice; a manual run must send
    `{"confirm": true}` and fits in the owner's daily run limit (`runBudget`). With
    auto-publish on (the default, `pipeline_auto_publish`), an issue that passed all three
    checks is published at once and the owner is emailed; with it off, it is saved as a
    draft. A date that is already published is never run again (a manual run is refused
    before any billed turn; corrections go through rule 8). Cloudflare can fire a cron
    twice, so a scheduled run (cron or retry) claims its issue date in the one statement
    that opens its row (`claimRun`); keep that claim atomic. Check 1 (`checks.ts`, code only) must keep
    rejecting any quote not found in the fetched source and any number not in the
    sources. Check 2 (`review.ts`) must stay a different agent from the writer, fail
    closed (an item without a verdict is cut) and run check 1 again over every fix.
    `GET /api/admin/pipeline/sources` reads feeds and sources without calling an agent;
    keep it free.
11. **Email is opt-in, and leaving is one click.** Only `confirmed` subscribers (double
    opt-in) get the issue, and only a published one (`src/worker/email/`). Every issue email
    carries a working unsubscribe link and the one-click `List-Unsubscribe` headers, and
    unsubscribing never needs a login or a confirmation email. Links are signed with
    `link_signing_key` in `settings`; never rotate or delete it, or the unsubscribe links in
    every email already sent stop working. Subscriber addresses are personal data: never
    log them and never return them from an API, admin routes included (counts only). A
    recipient is claimed in `email_log` before each send so nobody gets a second copy.
    Every email carries the publisher's postal address (`EMAIL_POSTAL_ADDRESS`) and a
    Reply-To a person reads (`CONTACT_EMAIL`). A bounced or complaining address
    (`/api/webhooks/resend`) gets no more email. "Unsubscribe and delete my data" erases
    everything held about an address at once (`eraseSubscriber`), and `retention.ts`
    deletes the rest on the schedule the privacy page (`src/app/reader/privacy.ts`)
    promises: change the two together.
12. **Readers' questions are untrusted input, answered from the sources only.**
    `src/worker/ask/` sends a confirmed subscriber's question (ask key, re-checked against
    `subscribers` on every use) to a third agent, never the writer or reviewer, that runs
    in its own sandbox with every tool denied. Each question is one billed turn whose
    `messageId` derives from its `questions.id`, in a fresh context, with no reader address
    in the prompt. `verifyAnswer` decides what a reader sees: every sentence must cite a
    quote found verbatim in the story's sources, its values must be in those quotes, and
    anything shaped like a link, markup or a credential is dropped. "Not covered" is fixed
    copy, never model text. Keep the per-reader and site-wide daily limits, the cache, and
    the pause switch in /admin#questions.
13. **Every page is served with its own tags and status.** `src/worker/pages.ts` sends the
    app's `index.html` with each page's title, description, canonical link, language
    alternates and share card, and a 404 for an unknown path or an unpublished issue; its
    `classify` must match `parseRoute` in `src/app/reader/router.ts`. Email-link pages and
    `/admin` are `noindex` and never cached. Share images are `public/ai-news/og/`
    (`scripts/og-cards.mjs`).
14. **The owner hears about problems, and nobody else's address is in it.** `alerts.ts`
    emails the owner (the address in `/admin#issues`) when a scheduled run fails or
    publishes, a reader reports a problem, addresses bounce or sends fail. Each alert is
    claimed by key in `email_log` so it goes out once, at most 30 a day, and an alert never
    contains a subscriber's address. Reading counts (`daily_events`) are daily totals; the
    launch-gate measures (`reads`, `survey`) are keyed by the same salted hash as questions.

## Checks

Before pushing:

```bash
npm run check   # typecheck + build + wrangler deploy --dry-run
npm test        # vitest unit tests
```

After a deploy:

```bash
npm run smoke -- https://app.manyfold.ai/ai-news
```

## What is safe to change

Everything else: the copy, the styles, the page structure, extra tables, routes and pages.
Keep the connect flow (`src/worker/connect.ts`, `src/worker/a2a.ts`,
`src/worker/crypto.ts`): it is how the site reaches its three Manyfold agents.
