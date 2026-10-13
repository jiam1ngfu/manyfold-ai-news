#!/usr/bin/env node
/**
 * Renders the share cards (public/ai-news/og/card-en.png and card-zh.png, 1200×630) that
 * every page names as its og:image (src/worker/pages.ts), in the layout of the share
 * cards in docs/design/index.html, and the repository's social preview for GitHub from
 * docs/design/brand/github-social-preview.html (1280×640 at 2x, uploaded by hand under the
 * repository's Settings → Social preview). Needs Google Chrome and a network connection
 * for the fonts:
 *   node scripts/og-cards.mjs
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const root = new URL('..', import.meta.url).pathname;
const lockup = readFileSync(join(root, 'public/ai-news/brand/ai-in-5-lockup.svg'), 'utf8').replace('<svg ', '<svg class="lockup" ');
const out = join(root, 'public/ai-news/og');
mkdirSync(out, { recursive: true });

const CARDS = {
  en: {
    title: 'The AI news that matters, in <span class="m">5 minutes</span>.',
    lines: ['Every morning at 7, your time.', 'From the US, China and beyond.', 'Every number and quote checked against its source.'],
    foot: 'app.manyfold.ai/ai-news',
  },
  zh: {
    title: '<span class="m">5 分钟</span>读懂全球 AI。',
    lines: ['每天早上 7 点，当地时间送达。', '美国和中国都不漏。', '每个数字和引语都与原始来源核对。'],
    foot: 'app.manyfold.ai/ai-news',
  },
};

const page = (lang, card) => `<!doctype html><html lang="${lang === 'zh' ? 'zh-Hans' : 'en'}"><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400..700&family=Schibsted+Grotesk:wght@400..700&family=Noto+Serif+SC:wght@400;600&display=block" rel="stylesheet">
<style>
  html, body { margin: 0; }
  body { width: 1200px; height: 630px; background: #fff; color: #000; }
  .og { box-sizing: border-box; width: 1200px; height: 630px; padding: 64px 72px; display: flex; flex-direction: column; font-family: "Newsreader", "Noto Serif SC", Georgia, serif; }
  .lockup { height: 52px; width: auto; display: block; align-self: flex-start; }
  h1 { font-size: ${lang === 'zh' ? '76px' : '72px'}; line-height: 1.1; font-weight: ${lang === 'zh' ? 600 : 500}; letter-spacing: ${lang === 'zh' ? '0' : '-0.015em'}; margin: 64px 0 0; max-width: 1000px; }
  .m { white-space: nowrap; padding: 0 .1em; background: linear-gradient(to bottom, transparent .2em, #FFE45C .2em, #FFE45C calc(100% - .06em), transparent calc(100% - .06em)); }
  ul { list-style: none; margin: auto 0 0; padding: 0; font: 400 28px/1.5 "Schibsted Grotesk", "PingFang SC", sans-serif; color: #000; }
  li { padding: 10px 0; border-top: 1px solid #E6E4DE; }
  li:first-child { border-top: 2px solid #000; }
  .foot { font: 400 22px/1 "Schibsted Grotesk", sans-serif; color: #5F5E58; margin-top: 22px; }
</style></head><body><div class="og">
${lockup}
<h1>${card.title}</h1>
<ul>${card.lines.map((l) => `<li>${l}</li>`).join('')}</ul>
<div class="foot">${card.foot}</div>
</div></body></html>`;

const dir = mkdtempSync(join(tmpdir(), 'aiin5-og-'));
for (const [lang, card] of Object.entries(CARDS)) {
  const html = join(dir, `${lang}.html`);
  writeFileSync(html, page(lang, card));
  const png = join(out, `card-${lang}.png`);
  execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', '--window-size=1200,630', '--virtual-time-budget=8000', `--screenshot=${png}`, `file://${html}`], { stdio: 'ignore' });
  console.log(`wrote ${png}`);
}

// The GitHub preview is its own design, aimed at people looking at the code.
const social = join(root, 'docs/design/brand/github-social-preview.html');
const preview = join(root, 'docs/design/brand/github-social-preview.png');
execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2', '--window-size=1280,640', '--virtual-time-budget=8000', `--screenshot=${preview}`, `file://${social}`], { stdio: 'ignore' });
console.log(`wrote ${preview}`);
