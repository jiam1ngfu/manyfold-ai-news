/**
 * One story: meta line with the company logo, headline, summary with checked numbers,
 * the visual (our chart or the source's own image), "Why it matters", sources, and the
 * preset questions with their cited answers.
 */

import { useState } from 'react';
import type { AskPreset, ChartRow, Issue, Lang, Org, Quote, Story } from '../../shared/issue';
import { COPY, KIND_NAMES, REGION_NAMES, languageName, sep, sourceTime } from './i18n';
import RichText, { MarkButton, type MarkControls } from './RichText';
import { sendReport } from './data';

export function Logo({ org }: { org?: Org }) {
  if (!org) return null;
  return (
    <span className="logo">
      <img src={org.logo} alt={org.name} width={20} height={20} />
    </span>
  );
}

function Proof({ story, index, lang }: { story: Story; index: number; lang: Lang }) {
  const T = COPY[lang];
  const mark = story.marks[index];
  const src = story.sources[mark.src];
  const tr = src.lang !== lang ? mark.tr?.[lang] : undefined;
  return (
    <div className="proof" role="note">
      <p className="proof-head">{T.matches}</p>
      <p className="proof-quote" lang={src.lang}>
        “{mark.quote}”
      </p>
      {tr && (
        <p className="proof-meta">
          {T.translatedFrom(languageName(src.lang, lang))}
          {sep(lang)}
          {tr}
        </p>
      )}
      <p className="proof-meta">
        {KIND_NAMES[src.kind][lang]}
        {sep(lang)}
        {src.name[lang]}, {sourceTime(src.time, lang)}
      </p>
    </div>
  );
}

function ChartValue({ row, lang, marks }: { row: ChartRow; lang: Lang; marks: MarkControls }) {
  return row.mark === undefined ? <>{row.shown[lang]}</> : <MarkButton index={row.mark} text={row.shown[lang]} controls={marks} />;
}

function DataTable({ title, rows, lang }: { title: string; rows: ChartRow[]; lang: Lang }) {
  return (
    <table className="visually-hidden">
      <caption>{title}</caption>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            <th scope="row">{r.label[lang]}</th>
            <td>{r.shown[lang]}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Visual({ story, lang, marks, eager }: { story: Story; lang: Lang; marks: MarkControls; eager: boolean }) {
  const v = story.visual;
  if (!v) return null;
  if (v.type === 'image') {
    return (
      <figure className="visual">
        <div className="photo-frame">
          <img src={v.src} alt={v.alt[lang]} loading={eager ? 'eager' : 'lazy'} />
        </div>
        <figcaption className="fg-credit">{v.credit[lang]}</figcaption>
      </figure>
    );
  }
  if (v.type === 'compare') {
    const max = Math.max(...v.rows.map((r) => r.value)) || 1;
    return (
      <figure className="visual">
        <figcaption className="fg-title">{v.title[lang]}</figcaption>
        {v.note && <p className="fg-note">{v.note[lang]}</p>}
        <div className="fg-rows" aria-hidden="true">
          {v.rows.map((r, i) => (
            <div className="fg-row" key={i}>
              <span>{r.label[lang]}</span>
              <span className="fg-track">
                <span className={`fg-bar ${r.focus ? 'focus' : 'ctx'}`} style={{ width: `calc((100% - 3.4rem) * ${r.value / max})` }} />
                <span className="fg-val">
                  <ChartValue row={r} lang={lang} marks={marks} />
                </span>
              </span>
            </div>
          ))}
        </div>
        <DataTable title={v.title[lang]} rows={v.rows} lang={lang} />
        <p className="fg-credit">{v.credit[lang]}</p>
      </figure>
    );
  }
  const max = Math.max(...v.rows.map((r) => Math.abs(r.value))) || 1;
  return (
    <figure className="visual">
      <figcaption className="fg-title">{v.title[lang]}</figcaption>
      <div className="fg-rows" aria-hidden="true">
        <div className="fg-axis">
          <span>{v.axis[lang][0]}</span>
          <span>{v.axis[lang][1]}</span>
        </div>
        {v.rows.map((r, i) => {
          const bar = (
            <>
              <span className="fg-bar focus" style={{ width: `calc((100% - 3.6rem) * ${Math.abs(r.value) / max})` }} />
              <span className="fg-val">
                <ChartValue row={r} lang={lang} marks={marks} />
              </span>
            </>
          );
          return (
            <div className="fg-change" key={i}>
              <span className="fg-label">{r.label[lang]}</span>
              <div className="fg-div">
                <span className="fg-half neg">{r.value < 0 && bar}</span>
                <span className="fg-half pos">{r.value > 0 && bar}</span>
              </div>
            </div>
          );
        })}
      </div>
      <DataTable title={v.title[lang]} rows={v.rows} lang={lang} />
      <p className="fg-credit">{v.credit[lang]}</p>
    </figure>
  );
}

function ReportButton({ issue, story, target, lang }: { issue: Issue; story: Story; target: string; lang: Lang }) {
  const T = COPY[lang];
  const [sent, setSent] = useState(false);
  if (sent) return <span>{T.reported}</span>;
  return (
    <button
      type="button"
      className="text-btn"
      onClick={() => {
        setSent(true);
        sendReport(issue.date, story.id, target, lang).catch(() => setSent(false));
      }}
    >
      {T.report}
    </button>
  );
}

function CiteList({ story, cites, lang, citeKey }: { story: Story; cites: Quote[]; lang: Lang; citeKey: string }) {
  const T = COPY[lang];
  return (
    <ol className="cites">
      {cites.map((c, i) => {
        const src = story.sources[c.src];
        const tr = src.lang !== lang ? c.tr?.[lang] : undefined;
        return (
          <li key={i} id={`${citeKey}-${i + 1}`}>
            <span className="cite-n">{i + 1}</span>
            {KIND_NAMES[src.kind][lang]}
            {sep(lang)}
            {src.name[lang]}
            <span className="cite-quote" lang={src.lang}>
              “{c.quote}”
            </span>
            {tr && (
              <span>
                {T.translatedFrom(languageName(src.lang, lang))}
                {sep(lang)}
                {tr}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** A checked answer: a preset one, or (with reportTarget "own:<id>") a reader's own. */
export function Answer({
  issue,
  story,
  preset,
  index,
  lang,
  reportTarget,
}: {
  issue: Issue;
  story: Story;
  preset: AskPreset;
  index: number | string;
  lang: Lang;
  reportTarget?: string;
}) {
  const T = COPY[lang];
  const citeKey = `c-${story.id}-${index}`;
  return (
    <div className="answer">
      <p className="status">
        <span className={`dot ${preset.status}`} aria-hidden="true" />
        {T.status[preset.status]}
      </p>
      <p className="answer-text">
        <RichText text={preset.a[lang]} citeKey={citeKey} />
      </p>
      <CiteList story={story} cites={preset.cites} lang={lang} citeKey={citeKey} />
      <p className="answer-foot">
        {T.answerFoot} <ReportButton issue={issue} story={story} target={reportTarget ?? `answer:${index}`} lang={lang} />
      </p>
    </div>
  );
}

/** The preset questions; used beside the story and inside the ask sheet. */
export function AskList({ issue, story, lang, idPrefix }: { issue: Issue; story: Story; lang: Lang; idPrefix: string }) {
  const [open, setOpen] = useState<number[]>([]);
  const toggle = (i: number) => setOpen((o) => (o.includes(i) ? o.filter((x) => x !== i) : [...o, i]));
  return (
    <>
      {story.ask.map((preset, i) => {
        const expanded = open.includes(i);
        const id = `${idPrefix}-${story.id}-${i}`;
        return (
          <li key={i}>
            <button type="button" className="ask-q" aria-expanded={expanded} aria-controls={id} onClick={() => toggle(i)}>
              <span>{preset.q[lang]}</span>
              <span className="pm" aria-hidden="true" />
            </button>
            <div id={id}>{expanded && <Answer issue={issue} story={story} preset={preset} index={i} lang={lang} />}</div>
          </li>
        );
      })}
    </>
  );
}

export default function StoryCard({
  issue,
  story,
  lang,
  onAskOwn,
}: {
  issue: Issue;
  story: Story;
  lang: Lang;
  onAskOwn: (storyId: string) => void;
}) {
  const T = COPY[lang];
  const [openMark, setOpenMark] = useState<number | null>(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const marks: MarkControls = { storyId: story.id, open: openMark, toggle: (i) => setOpenMark((m) => (m === i ? null : i)) };

  return (
    <article className={story.top ? 'story is-top' : 'story'} id={`s-${story.id}`}>
      <div className="story-main">
        <p className="meta">
          <Logo org={story.org} />
          <span className="region">{REGION_NAMES[story.region][lang]}</span>
          <span>{story.cat[lang]}</span>
        </p>
        <h2 className="title">{story.title[lang]}</h2>
        <p className="summary">
          <RichText text={story.summary[lang]} marks={marks} />
        </p>
        <div id={`proof-${story.id}`}>{openMark !== null && story.marks[openMark] && <Proof story={story} index={openMark} lang={lang} />}</div>
        <Visual story={story} lang={lang} marks={marks} eager={story.top === true} />
        <div className="why">
          <p className="label">{T.why}</p>
          <p>{story.why[lang]}</p>
        </div>
        {story.next && (
          <div className="next">
            <p className="label">{T.next}</p>
            <p>{story.next[lang]}</p>
          </div>
        )}
        <div className="sources">
          <div className="sources-row">
            <span>{story.sourceLine[lang]}</span>
            <button type="button" className="text-btn" aria-expanded={sourcesOpen} aria-controls={`src-${story.id}`} onClick={() => setSourcesOpen((o) => !o)}>
              {sourcesOpen ? T.hideSources : T.seeSources}
            </button>
          </div>
          <ul className="source-list" id={`src-${story.id}`} hidden={!sourcesOpen}>
            {story.sources.map((src, i) => {
              const notes = [src.lang !== lang ? languageName(src.lang, lang) : '', src.paywall ? T.paywall : ''].filter(Boolean).join(', ');
              return (
                <li key={i}>
                  <span className="kind">{KIND_NAMES[src.kind][lang]}</span>
                  <span>
                    {src.name[lang]}
                    {notes && `, ${notes}`}
                    <br />
                    {sourceTime(src.time, lang)}
                  </span>
                  <a href={src.url} target="_blank" rel="noopener noreferrer">
                    {T.open}
                  </a>
                </li>
              );
            })}
            <li className="report-row">
              <ReportButton issue={issue} story={story} target="story" lang={lang} />
            </li>
          </ul>
        </div>
      </div>
      <aside className="story-ask" aria-label={T.askAbout}>
        <p className="ask-label">{T.ask}</p>
        <ul className="ask-list">
          <AskList issue={issue} story={story} lang={lang} idPrefix="ans" />
          <li>
            <button type="button" className="ask-own" onClick={() => onAskOwn(story.id)}>
              <span>{T.askOwn}</span>
            </button>
          </li>
        </ul>
      </aside>
    </article>
  );
}
