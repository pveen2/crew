// A pretend conductor with sample threads, for trying the iPhone app in the
// Simulator without a team server or signed-in agents: `pnpm ios:demo`, then
// sign in to 127.0.0.1:4390 with the token "demo". It speaks the same API and
// WebSocket as apps/conductor, answers messages with a canned reply, and
// settles approvals and questions. Nothing is stored; a restart starts over.

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT ?? 4390);
const TOKEN = 'demo';
const ME = 'paul@example.com';
const now = Date.now();
const min = 60_000;

const people = [
  { email: ME, name: 'Paul' },
  { email: 'juliette@example.com', name: 'Juliette' },
  { email: 'sam@example.com', name: 'Sam' },
];

const roles = [
  { name: 'gm', label: 'GM', description: 'General manager. Owns every thread and hands work to the right specialist.', engine: 'claude-code', model: 'opus', permissions: 'draft', isLead: true },
  { name: 'store-manager', label: 'Store manager', description: 'Runs the Shopify store: products, prices, collections and discounts.', engine: 'claude-code', model: 'sonnet', permissions: 'draft', isLead: false },
  { name: 'developer', label: 'Developer', description: 'Works in the theme repo, previews changes and opens pull requests.', engine: 'codex', model: 'gpt-5.5', permissions: 'code', isLead: false },
  { name: 'data-analyst', label: 'Data analyst', description: 'Answers questions with numbers from Shopify, GA4 and Search Console.', engine: 'claude-code', model: 'sonnet', permissions: 'read-only', isLead: false },
  { name: 'web-researcher', label: 'Web researcher', description: 'Researches the public web and X and returns a sourced report.', engine: 'claude-code', model: 'sonnet', permissions: 'read-only', isLead: false },
];

const usage = { costUsd: 0.42, inputTokens: 120_000, outputTokens: 8_000 };
let eventId = 0;
const threads = new Map();
const inbox = new Map();
const dms = new Map();
const dmMessages = new Map();
let dmMessageId = 0;

function thread(id, title, status, statusText, roleList, ageMin, extra = {}) {
  const t = {
    id, title, status, statusText, rootSessionId: `${id}-gm`, createdAt: now - ageMin * min - 20 * min, updatedAt: now - ageMin * min,
    archived: false, roles: roleList, benched: [], usage, createdBy: ME, people: [ME], ...extra,
  };
  threads.set(id, { thread: t, sessions: [session(t, 'gm', 0)], turns: [], events: [] });
  return threads.get(id);
}

function session(t, role, depth, status = 'idle') {
  const r = roles.find((x) => x.name === role);
  return {
    id: depth === 0 ? t.rootSessionId : `${t.id}-${role}`, threadId: t.id, role, engine: r.engine, model: r.model, status,
    engineSessionId: null, parentSessionId: depth === 0 ? null : t.rootSessionId, depth, workdir: '/tmp', createdAt: t.createdAt, updatedAt: t.updatedAt,
  };
}

function ev(d, body, { session: sessionId = d.thread.rootSessionId, turn = 'turn-1', ago = 0 } = {}) {
  const e = { id: ++eventId, threadId: d.thread.id, sessionId, turnId: turn, ts: now - ago * min, ...body };
  d.events.push(e);
  return e;
}

// --- 1. Needs you: a question with options --------------------------------
{
  const d = thread('t-sale', 'Summer sale: which products go to 20% off?', 'needs_you', 'Needs you', ['gm', 'store-manager', 'data-analyst'], 3);
  d.sessions.push(session(d.thread, 'store-manager', 1), session(d.thread, 'data-analyst', 1));
  ev(d, { type: 'message', role: 'user', text: 'We want a summer sale next week. Which products should go to 20% off?', from: 'owner', by: ME }, { ago: 24 });
  ev(d, { type: 'thinking', text: 'I need the sales of the last 90 days and the current stock levels.' }, { ago: 23 });
  ev(d, { type: 'subagent_started', childSessionId: 't-sale-data-analyst', childTurnId: 'c1', role: 'data-analyst', engine: 'claude-code', model: 'sonnet', brief: 'Sales per product, last 90 days, with margin.' }, { ago: 23 });
  ev(d, { type: 'subagent_started', childSessionId: 't-sale-store-manager', childTurnId: 'c2', role: 'store-manager', engine: 'claude-code', model: 'sonnet', brief: 'Stock per product and anything already discounted.' }, { ago: 23 });
  ev(d, { type: 'subagent_done', childSessionId: 't-sale-data-analyst', childTurnId: 'c1', role: 'data-analyst', status: 'done', result: '14 products sold fewer than 20 units in 90 days; 6 of them have a margin above 60%.', durationMs: 252_000 }, { ago: 19 });
  ev(d, { type: 'subagent_done', childSessionId: 't-sale-store-manager', childTurnId: 'c2', role: 'store-manager', status: 'done', result: 'Stock is high on the linen range (420 units). Nothing is discounted right now.', durationMs: 98_000 }, { ago: 21 });
  ev(d, { type: 'message', role: 'assistant', text: `Here's what the team found:\n\n| Product | Units (90d) | Margin | Stock |\n|---|---|---|---|\n| Linen shirt | 12 | 64% | 180 |\n| Linen trousers | 9 | 61% | 140 |\n| Straw hat | 17 | 66% | 100 |\n\nThe **linen range** sells slowly, has room in its margin and plenty of stock. That makes it the best fit for 20% off.` }, { ago: 4 });
  ev(d, {
    type: 'needs_you', question: 'Which products should get the 20% discount?', inboxId: 'q-sale',
    options: [
      { label: 'The linen range only', detail: '3 products · about €2,100 less margin if all sell' },
      { label: 'Linen plus the straw hat', detail: '4 products · about €2,600 less margin' },
      { label: 'Everything under 20 units', detail: '14 products · about €5,900 less margin' },
    ],
    recommended: 0,
  }, { ago: 3 });
  inbox.set('q-sale', { id: 'q-sale', threadId: 't-sale', sessionId: 't-sale-gm', kind: 'needs_you', role: 'gm', title: 'Which products should get the 20% discount?', body: 'The linen range sells slowly and has the most room in its margin.', options: [], status: 'open', createdAt: now - 3 * min });
}

// --- 2. Running, with an approval waiting -----------------------------------
{
  const d = thread('t-banner', 'Fix the checkout banner on mobile', 'needs_you', 'Developer: waiting for your approval', ['gm', 'developer'], 1, { people: [ME, 'juliette@example.com'] });
  d.sessions.push(session(d.thread, 'developer', 1, 'running'));
  d.sessions[0].status = 'running';
  ev(d, { type: 'message', role: 'user', text: 'The free-shipping banner covers the pay button on small phones. Can you fix it?', from: 'owner', by: 'juliette@example.com' }, { ago: 12 });
  ev(d, { type: 'message', role: 'user', text: '@GM screenshot is in Slack, it is the iPhone SE size', from: 'owner', by: ME }, { ago: 11, turn: 'turn-1' });
  ev(d, { type: 'subagent_started', childSessionId: 't-banner-developer', childTurnId: 'c3', role: 'developer', engine: 'codex', model: 'gpt-5.5', brief: 'Make the free-shipping banner stop covering the pay button below 380px.' }, { ago: 10 });
  const dev = d.thread.id + '-developer';
  ev(d, { type: 'turn_started', prompt: 'Brief from GM\n\nMake the free-shipping banner stop covering the pay button below 380px.', resumed: false, callerRole: 'gm' }, { session: dev, turn: 'c3', ago: 10 });
  ev(d, { type: 'tool_call', callId: 'a1', name: 'Bash', input: { command: 'rg -n "free-shipping" sections/' } }, { session: dev, turn: 'c3', ago: 9 });
  ev(d, { type: 'tool_result', callId: 'a1', output: 'sections/cart-banner.liquid:12: <div class="free-shipping sticky">', isError: false }, { session: dev, turn: 'c3', ago: 9 });
  ev(d, { type: 'message', role: 'assistant', text: 'The banner is `position: sticky` with `bottom: 0`. Below 380px I made it part of the page flow instead, so it scrolls away above the pay button.' }, { session: dev, turn: 'c3', ago: 4 });
  ev(d, { type: 'approval', inboxId: 'a-banner', toolName: 'mcp__crew__open_pull_request', input: { title: 'Free-shipping banner: no overlap on small phones' } }, { session: dev, turn: 'c3', ago: 1 });
  inbox.set('a-banner', {
    id: 'a-banner', threadId: 't-banner', sessionId: dev, kind: 'approval', role: 'developer', title: 'Open a pull request: “Free-shipping banner: no overlap on small phones”',
    body: '```diff\n- .free-shipping { position: sticky; bottom: 0; }\n+ @media (max-width: 380px) {\n+   .free-shipping { position: static; }\n+ }\n```', status: 'open', createdAt: now - min,
  });
}

// --- 3. Done: an answer with a draft ------------------------------------------
{
  const d = thread('t-ship', 'What does it cost to ship 2 kg to Spain?', 'idle', '', ['gm', 'web-researcher'], 50);
  d.sessions.push(session(d.thread, 'web-researcher', 1));
  ev(d, { type: 'message', role: 'user', text: 'What does it cost to ship a 2 kg parcel from the Netherlands to Spain? Compare three carriers.', from: 'owner', by: ME }, { ago: 58 });
  ev(d, { type: 'subagent_started', childSessionId: 't-ship-web-researcher', childTurnId: 'c4', role: 'web-researcher', engine: 'claude-code', model: 'sonnet', brief: 'Prices for 2 kg NL to ES with PostNL, DHL and DPD.' }, { ago: 57 });
  ev(d, { type: 'subagent_done', childSessionId: 't-ship-web-researcher', childTurnId: 'c4', role: 'web-researcher', status: 'done', result: 'PostNL €13.95, DHL €11.50, DPD €10.20 (drop-off), all 3–5 working days.', durationMs: 184_000 }, { ago: 54 });
  ev(d, { type: 'message', role: 'assistant', text: '**DPD is cheapest** at €10.20 if you drop the parcel off yourself.\n\n1. DPD: €10.20, 3–4 days, drop-off at a pickup point\n2. DHL: €11.50, 3–5 days, collected from you\n3. PostNL: €13.95, 4–5 days, tracked and insured up to €500\n\nI wrote it up as a short note for the team.' }, { ago: 51 });
  ev(d, { type: 'preview', previewId: 'p1', title: 'Shipping to Spain: carrier comparison', format: 'markdown', content: '# Shipping to Spain\n\nFor a 2 kg parcel from the Netherlands:\n\n| Carrier | Price | Days |\n|---|---|---|\n| DPD | €10.20 | 3–4 |\n| DHL | €11.50 | 3–5 |\n| PostNL | €13.95 | 4–5 |\n\n**Advice:** use DPD for standard orders and PostNL when the order is worth more than €200, for the insurance.' }, { ago: 51 });
}

// --- 4. Closed ---------------------------------------------------------------
{
  const d = thread('t-old', 'Newsletter subject lines for the autumn drop', 'idle', '', ['gm'], 60 * 26);
  d.thread.archived = true;
  ev(d, { type: 'message', role: 'user', text: 'Five subject lines for the autumn newsletter?', from: 'owner', by: ME }, { ago: 60 * 27 });
  ev(d, { type: 'message', role: 'assistant', text: '1. Autumn, unpacked\n2. The layers are back\n3. Warm colours, cold mornings\n4. New in: the autumn edit\n5. Sweater weather starts here' }, { ago: 60 * 26 });
}

// --- DMs ---------------------------------------------------------------------
function addDm(id, other, msgs) {
  const list = msgs.map(([by, text, ago]) => ({ id: ++dmMessageId, dmId: id, by, text, ts: now - ago * min }));
  dmMessages.set(id, list);
  const last = list.at(-1);
  dms.set(id, { id, people: [ME, other], createdAt: list[0].ts, updatedAt: last.ts, last: { by: last.by, text: last.text, ts: last.ts } });
}
addDm('dm-juliette', 'juliette@example.com', [
  ['juliette@example.com', 'Did you see the banner bug on the small iPhones?', 15],
  [ME, 'Yes, I asked the GM, the developer is on it', 13],
  ['juliette@example.com', 'Nice, ping me when the PR is up 🙏', 2],
]);
addDm('dm-sam', 'sam@example.com', [[ME, 'Can you check the linen stock numbers tomorrow?', 60 * 5], ['sam@example.com', 'Will do', 60 * 4]]);

// --- API ---------------------------------------------------------------------
const clients = new Set();
const broadcast = (msg) => {
  const data = JSON.stringify(msg);
  for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(data);
};

function state() {
  const all = [...threads.values()].map((d) => d.thread);
  return {
    team: { name: 'Wakey', suggestions: ['Which products should go in the summer sale?', 'What are people on X saying about linen this month?', 'Check the store for products without a description'] },
    threads: all.filter((t) => !t.archived).sort((a, b) => b.updatedAt - a.updatedAt),
    done: all.filter((t) => t.archived),
    inbox: [...inbox.values()].filter((i) => i.status === 'open'),
    roles,
    activity: [
      { role: 'developer', sessionId: 't-banner-developer', threadId: 't-banner', threadTitle: 'Fix the checkout banner on mobile', status: 'running', doing: 'Waiting for your approval', since: now - 10 * min },
    ],
    sharing: false,
    me: ME,
    people,
    dms: [...dms.values()].sort((a, b) => b.updatedAt - a.updatedAt),
  };
}

function touch(d, patch) {
  Object.assign(d.thread, { updatedAt: Date.now(), ...patch });
  broadcast({ kind: 'thread', thread: d.thread });
}

function emit(d, body, opts = {}) {
  const e = ev(d, body, opts);
  e.ts = Date.now();
  broadcast({ kind: 'event', event: e });
  return e;
}

/** The GM "works" for a moment, then writes its answer as it goes (drafts), then sends it. */
function reply(d, text) {
  const root = d.sessions[0];
  root.status = 'running';
  broadcast({ kind: 'session', session: root });
  touch(d, { status: 'running', statusText: 'GM: thinking' });
  setTimeout(() => emit(d, { type: 'tool_call', callId: `c${eventId}`, name: 'mcp__shopify__query', input: { query: 'products(first: 20)' } }), 700);
  // Text comes in bursts of a few words, as from a real engine.
  const words = text.split(/(?<=\s)/);
  let at = 0;
  const step = () => {
    at = Math.min(words.length, at + 1 + Math.floor(Math.random() * 4));
    broadcast({ kind: 'draft', threadId: d.thread.id, sessionId: root.id, text: words.slice(0, at).join('') });
    if (at < words.length) return void setTimeout(step, 80 + Math.random() * 160);
    setTimeout(() => {
      emit(d, { type: 'message', role: 'assistant', text });
      root.status = 'idle';
      broadcast({ kind: 'session', session: root });
      touch(d, { status: 'idle', statusText: '' });
    }, 300);
  };
  setTimeout(step, 1500);
}

async function body(req) {
  let s = '';
  for await (const c of req) s += c;
  return s ? JSON.parse(s) : {};
}

const send = (res, status, data) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: 'Unauthorized' });
  const [, api, a, id, action] = url.pathname.split('/');
  if (api !== 'api') return send(res, 404, { error: 'Not found' });
  const post = req.method === 'POST';

  if (a === 'state') return send(res, 200, state());
  if (a === 'threads' && !id && post) {
    const b = await body(req);
    const n = threads.size + 1;
    const d = thread(`t-new-${n}`, b.text.slice(0, 60), 'running', 'GM: thinking', ['gm'], 0);
    emit(d, { type: 'message', role: 'user', text: b.text, from: 'owner', by: ME });
    reply(d, 'Good question. I had a look at the store: **3 things** stand out.\n\n- The linen range has the most stock\n- Two products have no description\n- The straw hat is almost sold out\n\nShould I ask the store manager to fix the descriptions?');
    return send(res, 200, d.thread);
  }
  const d = threads.get(id);
  if (a === 'threads' && d && !action) return send(res, 200, { ...d, share: null });
  if (a === 'threads' && d && action === 'messages' && post) {
    const b = await body(req);
    emit(d, { type: 'message', role: 'user', text: b.text, from: 'owner', by: ME, ...(b.replyTo && { replyTo: b.replyTo }) });
    if (b.replyTo && inbox.has(b.replyTo)) {
      const item = { ...inbox.get(b.replyTo), status: 'resolved' };
      inbox.set(item.id, item);
      broadcast({ kind: 'inbox', item });
    }
    reply(d, b.replyTo
      ? `Done: I'll set it up with **${b.text}**.\n\nHere's the plan:\n\n1. The store manager makes a 20% automatic discount for those products, starting Monday 09:00.\n2. The developer adds a small sale badge on the product cards.\n3. You get an approval for each change before it goes live.\n\nI'll check sales after the first weekend and tell you how it's going.`
      : 'On it. I looked at the last 90 days: **linen sells best on weekends**, mostly from Instagram traffic.\n\nI would start the sale on a Thursday so it runs into the first weekend.');
    return send(res, 200, { ok: true });
  }
  if (a === 'threads' && d && action === 'archive' && post) {
    touch(d, { archived: true });
    return send(res, 200, { ok: true });
  }
  if (a === 'threads' && d && action === 'title' && post) {
    touch(d, { title: (await body(req)).title });
    return send(res, 200, { ok: true });
  }
  if (a === 'sessions' && post) return send(res, 200, { ok: true });
  if (a === 'inbox' && id && post) {
    const item = inbox.get(id);
    if (!item) return send(res, 200, { error: 'No such item' });
    const done = { ...item, status: 'resolved' };
    inbox.set(id, done);
    broadcast({ kind: 'inbox', item: done });
    const t = threads.get(item.threadId);
    if (item.kind === 'approval') {
      const approved = action !== 'deny';
      emit(t, { type: 'approval_done', inboxId: id, toolName: 'mcp__crew__open_pull_request', approved }, { session: item.sessionId, turn: 'c3' });
      if (approved) emit(t, { type: 'message', role: 'assistant', text: 'Pull request opened: **#142 Free-shipping banner: no overlap on small phones**. The preview link is in the PR.' }, { session: item.sessionId, turn: 'c3' });
      touch(t, { status: 'idle', statusText: '' });
    }
    return send(res, 200, done);
  }
  if (a === 'dms' && !id && post) {
    const b = await body(req);
    const dmId = `dm-${b.with.join('-')}`;
    if (!dms.has(dmId)) {
      dms.set(dmId, { id: dmId, people: [ME, ...b.with], createdAt: Date.now(), updatedAt: Date.now() });
      dmMessages.set(dmId, []);
    }
    return send(res, 200, sendDm(dmId, b.text));
  }
  if (a === 'dms' && id && action === 'messages') {
    if (!post) return send(res, 200, dmMessages.get(id) ?? []);
    return send(res, 200, sendDm(id, (await body(req)).text));
  }
  if (a === 'docs' && id) return send(res, 404, { error: 'No such doc' });
  return send(res, 404, { error: 'Not found' });
});

function sendDm(dmId, text) {
  const message = { id: ++dmMessageId, dmId, by: ME, text, ts: Date.now() };
  dmMessages.get(dmId).push(message);
  const dm = Object.assign(dms.get(dmId), { updatedAt: message.ts, last: { by: ME, text, ts: message.ts } });
  broadcast({ kind: 'dm', dm });
  broadcast({ kind: 'dm_message', message });
  return { dm, message };
}

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws' || url.searchParams.get('token') !== TOKEN) {
    socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.send(JSON.stringify({ kind: 'hello', version: 1 }));
    ws.send(JSON.stringify({ kind: 'online', people: [ME, 'juliette@example.com'] }));
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`Demo conductor on http://127.0.0.1:${PORT} (token: ${TOKEN})`));
