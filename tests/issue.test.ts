import { describe, expect, it } from 'vitest';
import { IssueValidationError, plainText, readingMinutes, tokenize, validateIssue } from '../src/shared/issue';
import { SAMPLE_ISSUE } from '../src/worker/sample-issue';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('tokenize', () => {
  it('splits marks and citations out of plain text', () => {
    expect(tokenize('costs <m0>one-eighth</m0> as much[1].')).toEqual([
      { type: 'text', text: 'costs ' },
      { type: 'mark', index: 0, text: 'one-eighth' },
      { type: 'text', text: ' as much' },
      { type: 'cite', n: 1 },
      { type: 'text', text: '.' },
    ]);
  });

  it('leaves text without markers alone and never treats tags as HTML', () => {
    expect(tokenize('<b>bold</b>')).toEqual([{ type: 'text', text: '<b>bold</b>' }]);
  });

  it('strips markers for plain contexts', () => {
    expect(plainText('a <m1>35%</m1> drop[2]')).toBe('a 35% drop');
  });
});

describe('readingMinutes', () => {
  it('keeps the sample issue inside the five-minute promise in both languages', () => {
    for (const lang of ['en', 'zh'] as const) {
      const minutes = readingMinutes(SAMPLE_ISSUE, lang);
      expect(minutes).toBeGreaterThanOrEqual(1);
      expect(minutes).toBeLessThanOrEqual(5);
    }
  });
});

describe('validateIssue', () => {
  it('accepts the sample issue unchanged', () => {
    expect(validateIssue(clone(SAMPLE_ISSUE))).toEqual(clone(SAMPLE_ISSUE));
  });

  it('rejects a summary that points at a missing mark', () => {
    const issue = clone(SAMPLE_ISSUE);
    issue.stories[1].summary.en = 'Only <m3>30 million</m3> users.';
    expect(() => validateIssue(issue)).toThrow(IssueValidationError);
  });

  it('rejects an answer that cites more sources than it lists', () => {
    const issue = clone(SAMPLE_ISSUE);
    issue.stories[0].ask[0].a.zh = '可以[4]。';
    expect(() => validateIssue(issue)).toThrow(/cites \[4\]/);
  });

  it('rejects a rumor that carries a logo', () => {
    const issue = clone(SAMPLE_ISSUE);
    issue.briefs[1].org = { name: 'Qilin Lab', logo: 'https://qilinlab.example/logo.svg' };
    expect(() => validateIssue(issue)).toThrow(/rumors must not carry a logo/);
  });

  it('only allows https and data:image sources for images', () => {
    const issue = clone(SAMPLE_ISSUE);
    issue.stories[1].visual = { type: 'image', src: 'javascript:alert(1)', alt: { en: 'x', zh: 'x' }, credit: { en: 'x', zh: 'x' } };
    expect(() => validateIssue(issue)).toThrow(/https URL or a data:image URL/);
  });

  it('accepts a thin day with briefs only, never an empty issue', () => {
    const issue = clone(SAMPLE_ISSUE);
    issue.stories = [];
    issue.today = [];
    expect(validateIssue(issue).briefs.length).toBeGreaterThan(0);
    issue.briefs = [];
    expect(() => validateIssue(issue)).toThrow(/at least one story or brief/);
  });

  it('requires "Today in 3" to point at stories in the issue', () => {
    const issue = clone(SAMPLE_ISSUE);
    issue.today[0].id = 'missing';
    expect(() => validateIssue(issue)).toThrow(/today\[0\]\.id/);
  });
});
