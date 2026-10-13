#!/usr/bin/env node
/**
 * Smoke test against a running deployment (or local dev server):
 *   npm run smoke -- https://your-app.workers.dev
 *
 * Retries for a while, because a fresh deploy can take a moment to propagate.
 */

const base = (process.argv[2] ?? 'http://localhost:5173').replace(/\/+$/, '');
const ATTEMPTS = 12;
const DELAY_MS = 5_000;

const checks = [
  {
    name: 'GET /api/health returns ok',
    run: async () => {
      const response = await fetch(`${base}/api/health`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (body.status !== 'ok') throw new Error(`unexpected body: ${JSON.stringify(body)}`);
    },
  },
  {
    name: 'GET /api/state has agents and connect keys',
    run: async () => {
      const response = await fetch(`${base}/api/state`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (!Array.isArray(body.agents) || !('connect' in body)) {
        throw new Error(`unexpected body: ${JSON.stringify(body).slice(0, 200)}`);
      }
    },
  },
  {
    name: 'GET / serves the app shell',
    run: async () => {
      const response = await fetch(`${base}/`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      if (!html.includes('<div id="root">')) throw new Error('no #root element in HTML');
    },
  },
  {
    // With ADMIN_PASSWORD set, the admin gate answers first and does not reveal which
    // routes exist, so an unknown route is a 401 there and a 404 everywhere else.
    name: 'unknown /api/* routes return JSON 404 (401 behind the admin password)',
    run: async () => {
      const state = await (await fetch(`${base}/api/state`)).json();
      const [status, code] = state?.adminRequired ? [401, 'admin_password_invalid'] : [404, 'not_found'];
      const response = await fetch(`${base}/api/definitely-not-a-route`);
      if (response.status !== status) throw new Error(`HTTP ${response.status}, expected ${status}`);
      const body = await response.json();
      if (body?.error?.code !== code) throw new Error(`unexpected body: ${JSON.stringify(body)}`);
    },
  },
  {
    name: 'GET /en/ serves the reader with its share card',
    run: async () => {
      const response = await fetch(`${base}/en/`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      if (!html.includes('<meta property="og:image"')) throw new Error('no og:image tag');
    },
  },
  {
    name: 'an unknown page answers 404 with the app shell',
    run: async () => {
      const response = await fetch(`${base}/en/definitely-not-a-page`);
      if (response.status !== 404) throw new Error(`HTTP ${response.status}, expected 404`);
      if (!(await response.text()).includes('<div id="root">')) throw new Error('no #root element in HTML');
    },
  },
  {
    name: 'GET /sitemap.xml is a sitemap',
    run: async () => {
      const response = await fetch(`${base}/sitemap.xml`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!(await response.text()).includes('<urlset')) throw new Error('no <urlset>');
    },
  },
];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let ready = false;
for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
  try {
    const response = await fetch(`${base}/api/health`);
    if (response.ok) {
      ready = true;
      break;
    }
  } catch {
    /* not up yet */
  }
  console.log(`waiting for ${base} (${attempt}/${ATTEMPTS})…`);
  await wait(DELAY_MS);
}
if (!ready) {
  console.error(`✗ ${base} never became reachable`);
  process.exit(1);
}

let failed = 0;
for (const check of checks) {
  try {
    await check.run();
    console.log(`✓ ${check.name}`);
  } catch (error) {
    failed += 1;
    console.error(`✗ ${check.name}: ${error.message}`);
  }
}
process.exit(failed ? 1 : 0);
