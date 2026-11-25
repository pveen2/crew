import { useEffect, useState } from 'react';
import type { SpendDay, SpendResponse } from '@crew/protocol';
import { BlockStack, Card, InlineStack, Spinner, Text } from '@crew/ui';
import { loadSpend } from '../store';
import { RoleFace, humanize, money, tokenCount, useRoleLabels } from './common';

const DAYS = 30;

/** "3h 20m", "45m", "0m". */
function duration(ms: number): string {
  const min = Math.round(ms / 60_000);
  const h = Math.floor(min / 60);
  return h ? `${h}h ${String(min % 60).padStart(2, '0')}m` : `${min}m`;
}

/** "Mon 24 Nov" from "2026-11-24", read as a local date. */
function dayLabel(date: string, weekday = true): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    ...(weekday && { weekday: 'short' }),
    day: 'numeric',
    month: 'short',
  });
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** What the team did and what it would have cost at API prices, per day for the last 30 days. */
export function SpendOverview() {
  const [data, setData] = useState<SpendResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    loadSpend(DAYS)
      .then((d) => live && setData(d))
      .catch((err: Error) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, []);

  return (
    <Card>
      <BlockStack gap="500" className="settings-row spend">
        <BlockStack>
          <Text variant="bodyLg" weight="medium">
            Last {DAYS} days
          </Text>
          <Text variant="bodySm" tone="secondary">
            The work your team did, and what it would have cost at API prices. Agents run on your subscriptions, so this
            is not what you are billed.
          </Text>
        </BlockStack>
        {error ? (
          <Text variant="bodySm" tone="critical">
            Could not load spend: {error}
          </Text>
        ) : !data ? (
          <InlineStack gap="200" className="spend__loading">
            <Spinner size={14} label="Loading spend" />
          </InlineStack>
        ) : (
          <SpendBody data={data} hover={hover} setHover={setHover} />
        )}
      </BlockStack>
    </Card>
  );
}

function SpendBody({ data, hover, setHover }: { data: SpendResponse; hover: number | null; setHover: (i: number | null) => void }) {
  const labels = useRoleLabels();
  const { totals, days, agents } = data;
  // Engines without prices (Codex) report only tokens; chart those when nothing has a price.
  const byCost = totals.costUsd > 0;
  const value = (d: SpendDay) => (byCost ? d.costUsd : d.tokens);
  const max = Math.max(...days.map(value), 0);
  const fmt = (n: number) => (byCost ? money(n) : `${tokenCount(n)} tok`);
  const activeDays = days.filter((d) => d.turns > 0).length;
  const shown = hover === null ? null : days[hover];

  if (!totals.turns) {
    return (
      <Text variant="bodyMd" tone="secondary">
        No work in the last {DAYS} days yet.
      </Text>
    );
  }

  return (
    <>
      <div className="spend__stats">
        <Stat label="Spend" value={byCost ? money(totals.costUsd) : '–'} note={totals.unpricedTokens ? `+ ${tokenCount(totals.unpricedTokens)} tokens unpriced` : 'at API prices'} />
        <Stat label="Threads" value={String(totals.threads)} note={`on ${plural(activeDays, 'day')}`} />
        <Stat label="Agent turns" value={String(totals.turns)} note="specialists included" />
        <Stat label="Time working" value={duration(totals.workMs)} note="on your messages" />
        <Stat label="Tokens" value={tokenCount(totals.inputTokens + totals.outputTokens)} note={`${tokenCount(totals.outputTokens)} written`} />
      </div>

      <BlockStack gap="200">
        <InlineStack gap="200" className="spend__readout" aria-live="polite">
          {shown ? (
            <>
              <Text variant="bodySm" weight="medium">
                {dayLabel(shown.date)}
              </Text>
              <Text variant="bodySm" tone="secondary">
                {shown.turns
                  ? `${fmt(value(shown))} · ${plural(shown.threads, 'thread')} · ${plural(shown.turns, 'turn')} · ${duration(shown.workMs)}`
                  : 'No work'}
              </Text>
            </>
          ) : (
            <>
              <Text variant="bodySm" weight="medium">
                Per day
              </Text>
              <Text variant="bodySm" tone="secondary">
                {fmt((byCost ? totals.costUsd : totals.tokens) / days.length)} on average · {fmt(max)} at most
              </Text>
            </>
          )}
        </InlineStack>
        <div className="spend__chart" role="list" onMouseLeave={() => setHover(null)}>
          {days.map((d, i) => {
            const v = value(d);
            const pct = max ? (v / max) * 100 : 0;
            const label = `${dayLabel(d.date)}: ${d.turns ? `${fmt(v)}, ${plural(d.threads, 'thread')}, ${plural(d.turns, 'turn')}` : 'no work'}`;
            return (
              <div
                key={d.date}
                role="listitem"
                tabIndex={0}
                aria-label={label}
                className="spend__col"
                data-active={hover === i || undefined}
                data-today={i === days.length - 1 || undefined}
                onMouseEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
              >
                <div className="spend__bar" data-empty={!d.turns || undefined} style={{ height: d.turns ? `max(${pct}%, 3px)` : undefined }} />
              </div>
            );
          })}
        </div>
        <div className="spend__axis">
          <Text variant="caption" tone="tertiary">
            {dayLabel(days[0].date, false)}
          </Text>
          <Text variant="caption" tone="tertiary">
            {dayLabel(days[Math.floor(days.length / 2)].date, false)}
          </Text>
          <Text variant="caption" tone="tertiary">
            Today
          </Text>
        </div>
      </BlockStack>

      {agents.length > 0 && (
        <BlockStack gap="200">
          <Text variant="bodySm" weight="medium">
            By agent
          </Text>
          <ul className="spend__agents">
            {agents.map((a) => {
              const v = byCost ? a.costUsd : a.tokens;
              const top = byCost ? agents[0].costUsd : Math.max(...agents.map((x) => x.tokens));
              return (
                <li key={a.role} className="spend__agent">
                  <RoleFace role={a.role} size="xs" decorative />
                  <Text variant="bodySm" className="spend__agent-name">
                    {labels[a.role] ?? humanize(a.role)}
                  </Text>
                  <div className="spend__agent-track" aria-hidden>
                    <div className="spend__agent-fill" style={{ width: `${top ? (v / top) * 100 : 0}%` }} />
                  </div>
                  <Text variant="bodySm" tone="secondary" className="spend__agent-turns">
                    {plural(a.turns, 'turn')}
                  </Text>
                  <Text variant="bodySm" weight="medium" className="spend__agent-value">
                    {byCost && !a.costUsd && a.tokens ? `${tokenCount(a.tokens)} tok` : fmt(v)}
                  </Text>
                </li>
              );
            })}
          </ul>
        </BlockStack>
      )}
    </>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="spend__stat">
      <Text variant="caption" tone="secondary">
        {label}
      </Text>
      <span className="spend__stat-value">{value}</span>
      <Text variant="caption" tone="tertiary">
        {note}
      </Text>
    </div>
  );
}
