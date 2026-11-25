import { Fragment, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { Button, Icon, Text } from '@crew/ui';
import { parseConceptBoard, type BrandFont, type Concept, type ConceptBoard as Board } from '@crew/protocol';
import { attachmentUrl, loadBrandFont, sendMessage, useApp } from '../store';

/**
 * A round of ad concepts (format `concepts`): every concept drawn as the ad itself, image plus
 * headline in the team's brand fonts, next to its briefing and headline options. The owner keeps
 * or drops concepts, picks a headline and comments; "Send feedback" posts it all as one reply.
 */
export function ConceptBoard({ content, docId, threadId }: { content: string; docId: string; threadId?: string }) {
  const parsed = useMemo(() => {
    try {
      return { board: parseConceptBoard(content) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [content]);
  const fonts = useBrandFonts();
  const [feedback, setFeedback] = useFeedback(docId);
  const [sent, setSent] = useState(false);

  if (!parsed.board) {
    return (
      <div className="concepts">
        <Text as="p" tone="critical">
          {parsed.error}
        </Text>
      </div>
    );
  }
  const board = parsed.board;
  const style = {
    '--ad-font-text': fonts.text ? `"${fonts.text}", var(--cr-font-family)` : 'var(--cr-font-family)',
    '--ad-font-accent': fonts.accent ? `"${fonts.accent}", Georgia, serif` : 'Georgia, "Times New Roman", serif',
    '--ad-accent-weight': String(fonts.accentWeight ?? 400),
    '--ad-aspect': (board.aspect ?? '4:5').replace(':', ' / '),
  } as CSSProperties;
  const counted = Object.values(feedback).filter((f) => f.verdict || f.comment.trim() || f.headline !== undefined).length;

  return (
    <div className="concepts" style={style}>
      {board.intro ? (
        <Text as="p" variant="bodyLg" tone="secondary">
          {board.intro}
        </Text>
      ) : null}

      <div className="concepts-strip" role="list" aria-label="All concepts">
        {board.concepts.map((c, i) => (
          <button
            key={i}
            type="button"
            role="listitem"
            className={`concepts-thumb${feedback[i]?.verdict ? ` concepts-thumb--${feedback[i]!.verdict}` : ''}`}
            title={c.name}
            onClick={() => document.getElementById(conceptAnchor(docId, i))?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          >
            <AdMock concept={c} headline={chosen(c, feedback[i]?.headline)} threadId={threadId} small />
            <span className="concepts-thumb-label">
              {i + 1}. {c.name}
            </span>
          </button>
        ))}
      </div>

      {board.concepts.map((c, i) => {
        const f = feedback[i] ?? EMPTY;
        const headline = chosen(c, f.headline);
        const update = (patch: Partial<Feedback>) => {
          setSent(false);
          setFeedback({ ...feedback, [i]: { ...f, ...patch } });
        };
        return (
          <section key={i} id={conceptAnchor(docId, i)} className={`concept${f.verdict ? ` concept--${f.verdict}` : ''}`}>
            <AdMock concept={c} headline={headline} threadId={threadId} />
            <div className="concept-body">
              <Text as="h3" variant="headingMd">
                {i + 1}. {c.name}
              </Text>
              <Text as="p" tone="secondary">
                {c.angle}
              </Text>

              <dl className="concept-facts">
                <Fact label="Tells people">{c.tells}</Fact>
                <Fact label="Stops them">{c.stop}</Fact>
                <Fact label="Makes them click">{c.click}</Fact>
                <Fact label="Audience">{c.audience}</Fact>
                <Fact label="Image">{c.image.description}</Fact>
              </dl>

              <div className="concept-label">Headlines: click one to try it on the ad</div>
              <div className="concept-headlines" role="radiogroup" aria-label={`Headlines for ${c.name}`}>
                {c.headlines.map((h, j) => (
                  <button
                    key={j}
                    type="button"
                    role="radio"
                    aria-checked={headline === j}
                    className="concept-headline"
                    onClick={() => update({ headline: j })}
                  >
                    <span className="concept-star" aria-label={h.star ? 'Strongest' : undefined}>
                      {h.star ? '★' : ''}
                    </span>
                    <span className="concept-headline-text">
                      <Headline text={h.text} />
                    </span>
                    <span className="concept-count" title="Characters">
                      {plain(h.text).length}
                    </span>
                  </button>
                ))}
              </div>

              {c.primaryText || c.linkHeadline ? (
                <div className="concept-copy">
                  {c.primaryText ? (
                    <p>
                      <span className="concept-label">Primary text · {c.primaryText.length}</span>
                      {c.primaryText}
                    </p>
                  ) : null}
                  {c.linkHeadline ? (
                    <p>
                      <span className="concept-label">Link headline · {c.linkHeadline.length}</span>
                      {c.linkHeadline}
                    </p>
                  ) : null}
                </div>
              ) : null}

              {c.notes ? (
                <div className="concept-note">
                  <Icon name="alert" size={14} />
                  <span>{c.notes}</span>
                </div>
              ) : null}

              <div className="concept-actions">
                <Button size="slim" variant={f.verdict === 'keep' ? 'primary' : 'secondary'} aria-pressed={f.verdict === 'keep'} onClick={() => update({ verdict: f.verdict === 'keep' ? undefined : 'keep' })}>
                  Keep
                </Button>
                <Button size="slim" variant={f.verdict === 'drop' ? 'primary' : 'secondary'} aria-pressed={f.verdict === 'drop'} onClick={() => update({ verdict: f.verdict === 'drop' ? undefined : 'drop' })}>
                  Drop
                </Button>
                <input
                  className="concept-comment"
                  placeholder="Comment (optional)"
                  value={f.comment}
                  onChange={(e) => update({ comment: e.target.value })}
                  aria-label={`Comment on ${c.name}`}
                />
              </div>
            </div>
          </section>
        );
      })}

      {threadId ? (
        <div className="concepts-send">
          <Text as="span" tone="secondary">
            {sent ? 'Sent to the thread.' : counted ? `Feedback on ${counted} of ${board.concepts.length} concepts` : 'Keep, drop or comment, then send it in one go.'}
          </Text>
          <Button
            variant="primary"
            size="slim"
            disabled={!counted || sent}
            onClick={() => {
              void sendMessage(threadId, feedbackMessage(board, feedback)).then(() => setSent(true));
            }}
          >
            Send feedback
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** The ad as it would run: image (or a placeholder for it) and the headline. No logo. */
function AdMock({ concept, headline, threadId, small }: { concept: Concept; headline: number; threadId?: string; small?: boolean }) {
  const { image } = concept;
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    setSrc(null);
    if (!image.file || !threadId) return;
    let live = true;
    attachmentUrl(threadId, image.file).then(
      (url) => live && setSrc(url),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [image.file, threadId]);

  const bg = image.background ?? '#e9e4da';
  const text = image.textColor ?? (src ? '#ffffff' : readableOn(bg));
  const line = concept.headlines[headline]?.text ?? '';
  return (
    <div className={`ad${small ? ' ad--small' : ''} ad--${image.textPosition ?? 'top'}${src ? ' ad--photo' : ''}`} style={{ background: bg, color: text }}>
      {src ? <img className="ad-image" src={src} alt={image.description} /> : null}
      {!src && !small ? (
        <div className="ad-placeholder" style={{ color: text }}>
          <span>{image.description}</span>
        </div>
      ) : null}
      <div className="ad-headline">
        <Headline text={line} />
      </div>
    </div>
  );
}

/** "Hi, we're Wakey. *We only work mornings.*": the starred words in the accent font. */
function Headline({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\*[^*]+\*)/g).map((part, i) =>
        part.startsWith('*') && part.endsWith('*') && part.length > 2 ? (
          <em key={i} className="ad-accent">
            {part.slice(1, -1)}
          </em>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

function Fact({ label, children }: { label: string; children?: ReactNode }) {
  if (!children) return null;
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

/** The team's fonts, loaded into the app: CSS family names, or null to use the fallback. */
function useBrandFonts(): { text: string | null; accent: string | null; accentWeight?: number } {
  const fonts = useApp((s) => s.teamFonts);
  const [loaded, setLoaded] = useState<Record<string, string | null>>({});
  useEffect(() => {
    let live = true;
    for (const f of fonts) {
      loadBrandFont(f).then(
        (family) => live && setLoaded((l) => ({ ...l, [f.role]: family })),
        () => undefined,
      );
    }
    return () => {
      live = false;
    };
  }, [fonts]);
  const accent: BrandFont | undefined = fonts.find((f) => f.role === 'accent');
  return { text: loaded.text ?? null, accent: loaded.accent ?? null, accentWeight: loaded.accent ? accent?.weight : undefined };
}

interface Feedback {
  verdict?: 'keep' | 'drop';
  /** Index of the headline the owner picked; undefined = the starred one. */
  headline?: number;
  comment: string;
}
const EMPTY: Feedback = { comment: '' };

/** Kept per document while the app runs, so switching tabs does not lose it. */
const feedbackByDoc = new Map<string, Record<number, Feedback>>();
function useFeedback(docId: string): [Record<number, Feedback>, (f: Record<number, Feedback>) => void] {
  const [value, setValue] = useState<Record<number, Feedback>>(() => feedbackByDoc.get(docId) ?? {});
  useEffect(() => setValue(feedbackByDoc.get(docId) ?? {}), [docId]);
  return [
    value,
    (f) => {
      feedbackByDoc.set(docId, f);
      setValue(f);
    },
  ];
}

function chosen(c: Concept, picked: number | undefined): number {
  if (picked !== undefined && picked < c.headlines.length) return picked;
  const star = c.headlines.findIndex((h) => h.star);
  return star >= 0 ? star : 0;
}

function plain(text: string): string {
  return text.replace(/\*([^*]+)\*/g, '$1');
}

function conceptAnchor(docId: string, i: number): string {
  return `concept-${docId}-${i}`;
}

/** The owner's choices as one reply the agents can act on. */
export function feedbackMessage(board: Board, feedback: Record<number, Feedback>): string {
  const lines = ['Feedback on the concepts:'];
  const keep: string[] = [];
  board.concepts.forEach((c, i) => {
    const f = feedback[i];
    if (!f || (!f.verdict && !f.comment.trim() && f.headline === undefined)) return;
    const parts: string[] = [];
    if (f.verdict) parts.push(f.verdict === 'keep' ? 'keep' : 'drop');
    if (f.headline !== undefined) parts.push(`headline: "${plain(c.headlines[f.headline]?.text ?? '')}"`);
    if (f.comment.trim()) parts.push(f.comment.trim());
    lines.push(`- ${i + 1}. ${c.name}: ${parts.join('; ')}`);
    if (f.verdict === 'keep') keep.push(c.name);
  });
  const silent = board.concepts.filter((_, i) => !feedback[i]?.verdict).length;
  if (silent) lines.push(`(${silent} concept${silent === 1 ? '' : 's'} without a keep or drop.)`);
  return lines.join('\n');
}

/** Readable text for "Copy document". */
export function conceptBoardText(content: string): string {
  let board: Board;
  try {
    board = parseConceptBoard(content);
  } catch {
    return content;
  }
  const out: string[] = [];
  if (board.intro) out.push(board.intro, '');
  board.concepts.forEach((c, i) => {
    out.push(`${i + 1}. ${c.name}`, c.angle);
    if (c.tells) out.push(`Tells people: ${c.tells}`);
    if (c.stop) out.push(`Stops them: ${c.stop}`);
    if (c.click) out.push(`Makes them click: ${c.click}`);
    if (c.audience) out.push(`Audience: ${c.audience}`);
    out.push(`Image: ${c.image.description}`, 'Headlines:');
    c.headlines.forEach((h) => out.push(`- ${h.star ? '★ ' : ''}${plain(h.text)}`));
    if (c.primaryText) out.push(`Primary text: ${c.primaryText}`);
    if (c.linkHeadline) out.push(`Link headline: ${c.linkHeadline}`);
    if (c.notes) out.push(`Note: ${c.notes}`);
    out.push('');
  });
  return out.join('\n').trim();
}

/** Black or white, whichever reads better on a hex colour. */
function readableOn(color: string): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})/i.exec(color)?.[1];
  if (!hex) return '#111111';
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(full.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  const lum = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  return lum > 0.4 ? '#111111' : '#ffffff';
}
