import { useState, type ReactNode } from 'react';
import type { QuestionOption } from '@crew/protocol';
import { Button, Icon, Text, TextField, cx } from '@crew/ui';
import { sendMessage, useApp } from '../store';

/**
 * The answer an owner sends for a multiple-choice question: each picked option
 * on its own line, then anything they typed.
 */
export function composeAnswer(picked: string[], text: string): string {
  const typed = text.trim();
  if (!picked.length) return typed;
  if (picked.length === 1 && !typed) return picked[0]!;
  return [...picked.map((l) => `- ${l}`), ...(typed ? [`- ${typed}`] : [])].join('\n');
}

/**
 * The answer half of an ask_owner question, in the thread card and the Inbox.
 * Single choice: one button per option, a click sends it. Multiple choice: the
 * options toggle, Send sends the picked ones. Either way a text box takes
 * anything else.
 */
export function QuestionAnswer({
  threadId,
  sessionId,
  inboxId,
  options,
  recommended,
  multiSelect,
  autoFocus,
  actions,
}: {
  threadId: string;
  sessionId: string;
  inboxId: string;
  options?: QuestionOption[];
  recommended?: number;
  multiSelect?: boolean;
  autoFocus?: boolean;
  /** Extra buttons before Send (Dismiss). */
  actions?: ReactNode;
}) {
  const online = useApp((s) => s.connection === 'online');
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const send = async (answer: string) => {
    if (!answer.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      await sendMessage(threadId, answer.trim(), sessionId, inboxId);
      setText('');
      setPicked([]);
    } catch (err) {
      setError((err as Error).message || 'Could not send the answer.');
    } finally {
      setBusy(false);
    }
  };
  const hasOptions = Boolean(options?.length);
  const multi = hasOptions && Boolean(multiSelect);
  const answer = multi ? composeAnswer(picked.map((i) => options![i]!.label), text) : text.trim();
  const toggle = (i: number) => setPicked((p) => (p.includes(i) ? p.filter((x) => x !== i) : [...p, i].sort((a, b) => a - b)));
  return (
    <div className="answer-stack">
      {hasOptions ? (
        <div className="answer-options" role="group" aria-label={multi ? 'Pick one or more' : 'Answers'}>
          {multi ? (
            <Text variant="caption" tone="secondary">
              Pick one or more
            </Text>
          ) : null}
          {options!.map((o, i) => {
            const on = picked.includes(i);
            return (
              <button
                key={i}
                type="button"
                className={cx('answer-option', i === recommended && 'answer-option--recommended', on && 'answer-option--picked')}
                aria-pressed={multi ? on : undefined}
                disabled={busy || !online}
                onClick={() => (multi ? toggle(i) : void send(o.label))}
              >
                <span className="answer-option__label">
                  {multi ? (
                    <span className={cx('answer-check', on && 'answer-check--on')} aria-hidden>
                      {on ? <Icon name="check" size={12} /> : null}
                    </span>
                  ) : null}
                  {o.label}
                  {i === recommended ? (
                    <Text as="span" variant="caption" tone="secondary">
                      Suggested
                    </Text>
                  ) : null}
                </span>
                {o.detail ? (
                  <Text as="span" variant="bodySm" tone="secondary" className={multi ? 'answer-option__detail--indent' : undefined}>
                    {o.detail}
                  </Text>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
      <form
        className="answer-form"
        onSubmit={(e) => {
          e.preventDefault();
          void send(answer);
        }}
      >
        <TextField
          label={hasOptions ? 'Another answer' : 'Your answer'}
          placeholder={multi ? 'Add something else…' : hasOptions ? 'Or type something else…' : 'Your answer…'}
          value={text}
          onChange={setText}
          autoFocus={autoFocus && !hasOptions}
          disabled={!online || busy}
        />
        {actions}
        <Button variant={hasOptions && !multi ? 'secondary' : 'primary'} type="submit" disabled={!answer || busy || !online}>
          Send
        </Button>
      </form>
      {error ? (
        <Text variant="bodySm" tone="critical" role="alert">
          {error}
        </Text>
      ) : null}
    </div>
  );
}
