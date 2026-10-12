import { describe, expect, it } from 'vitest';
import { importSigningKey, signWith, verifyWith } from '../src/worker/email/tokens';
import { dueByDate, localClock } from '../src/worker/email/deliver';
import { renderConfirmEmail, renderIssueEmail, UNSUBSCRIBE } from '../src/worker/email/render';
import { SAMPLE_ISSUE } from '../src/worker/sample-issue';
import { validateIssue, type Issue } from '../src/shared/issue';

describe('link tokens', () => {
  it('round-trips, and rejects the wrong kind, a forged tag, another key or an expired link', async () => {
    const key = await importSigningKey('material-one');
    const unsub = await signWith(key, { kind: 'unsubscribe', email: 'a@example.com' });
    expect(await verifyWith(key, unsub, 'unsubscribe')).toBe('a@example.com');
    expect(await verifyWith(key, unsub, 'confirm')).toBeNull();
    const [body] = unsub.split('.');
    expect(await verifyWith(key, `${body}.AAAAAAAAAAAAAAAAAAAAAA`, 'unsubscribe')).toBeNull();
    expect(await verifyWith(await importSigningKey('material-two'), unsub, 'unsubscribe')).toBeNull();
    const confirm = await signWith(key, { kind: 'confirm', email: 'a@example.com', exp: 1_000 });
    expect(await verifyWith(key, confirm, 'confirm', 999_000)).toBe('a@example.com');
    expect(await verifyWith(key, confirm, 'confirm', 1_001_000)).toBeNull();
    expect(await verifyWith(key, 'not-a-token', 'confirm')).toBeNull();
  });

  it('cannot be edited to point at another address', async () => {
    const key = await importSigningKey('material-one');
    const token = await signWith(key, { kind: 'unsubscribe', email: 'a@example.com' });
    const forged = btoa(JSON.stringify({ k: 'u', e: 'b@example.com' })).replace(/=+$/, '');
    expect(await verifyWith(key, `${forged}.${token.split('.')[1]}`, 'unsubscribe')).toBeNull();
  });
});

describe('delivery timing', () => {
  // 2026-10-12 22:30 UTC: 07:30 on the 13th in Tokyo, 23:30 on the 12th in London.
  const at = new Date('2026-10-12T22:30:00Z');

  it('reads the local date and hour, and falls back to UTC for an unknown zone', () => {
    expect(localClock(at, 'Asia/Tokyo')).toEqual({ date: '2026-10-13', hour: 7 });
    expect(localClock(at, 'Europe/London')).toEqual({ date: '2026-10-12', hour: 23 });
    expect(localClock(at, 'Asia/Kolkata')).toEqual({ date: '2026-10-13', hour: 4 });
    expect(localClock(at, 'Mars/Olympus')).toEqual({ date: '2026-10-12', hour: 22 });
  });

  it('picks only subscribers inside their 07:00 to 12:00 window, by their local date', () => {
    const subs = [
      { email: 'tokyo@x.co', lang: 'zh' as const, timezone: 'Asia/Tokyo' },
      { email: 'shanghai@x.co', lang: 'zh' as const, timezone: 'Asia/Shanghai' },
      { email: 'sydney@x.co', lang: 'en' as const, timezone: 'Australia/Sydney' },
      { email: 'london@x.co', lang: 'en' as const, timezone: 'Europe/London' },
    ];
    const due = dueByDate(subs, at);
    // Shanghai is 06:30, too early; Sydney (UTC+11 in October) is 09:30.
    expect([...due.keys()]).toEqual(['2026-10-13']);
    expect(due.get('2026-10-13')?.map((s) => s.email)).toEqual(['tokyo@x.co', 'sydney@x.co']);
  });
});

describe('issue email', () => {
  const site = 'https://aiin5.example';

  it('renders the issue with highlights, links back and an unsubscribe placeholder, well under 100 KB', () => {
    for (const lang of ['en', 'zh'] as const) {
      const email = renderIssueEmail(SAMPLE_ISSUE, lang, site, 'AI in 5, 1 Example Street');
      expect(email.html).toContain('background:#FFE45C');
      expect(email.html).toContain(`${site}/${lang}/${SAMPLE_ISSUE.date}/1#ask`);
      expect(email.html).toContain(UNSUBSCRIBE);
      expect(email.text).toContain(UNSUBSCRIBE);
      expect(email.html).toContain('1 Example Street');
      expect(email.html).not.toMatch(/<\/?m\d+>|\[\d+\]/);
      expect(new TextEncoder().encode(email.html).length).toBeLessThan(100_000);
      expect(email.subject.length).toBeGreaterThan(5);
    }
  });

  it('escapes issue text and drops links that are not https', () => {
    const issue = structuredClone(SAMPLE_ISSUE) as Issue;
    issue.stories[0].title.en = 'A <script>alert(1)</script> & "quotes"';
    issue.stories[0].sources[0].url = 'javascript:alert(1)';
    const email = renderIssueEmail(issue, 'en', site);
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('A &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;');
    expect(email.html).not.toContain('javascript:');
  });

  it('works for the sample, which is a valid issue', () => {
    expect(() => validateIssue(SAMPLE_ISSUE)).not.toThrow();
  });
});

describe('confirmation email', () => {
  it('carries the link in both versions, in the reader’s language', () => {
    const url = 'https://aiin5.example/zh/confirm?t=abc.def';
    const email = renderConfirmEmail('zh', url);
    expect(email.subject).toContain('确认');
    expect(email.html).toContain(url);
    expect(email.text).toContain(url);
  });
});
