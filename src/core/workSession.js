// Survives across messages so "Done?" / "what about the site?" never looks amnesiac.
const { Collection } = require('../db');

const store = new Collection('work_sessions', {});
const TTL_MS = Number(process.env.WORK_SESSION_TTL_MS || 6 * 60 * 60 * 1000); // 6h

function key(chatId, userId) {
  return `${String(chatId || 'chat')}::${String(userId || 'user')}`;
}

function get(chatId, userId) {
  const s = store.get(key(chatId, userId), null);
  if (!s) return null;
  if (s.updatedAt && Date.now() - s.updatedAt > TTL_MS) {
    store.delete(key(chatId, userId));
    return null;
  }
  return s;
}

/**
 * @param {string} chatId
 * @param {string} userId
 * @param {object} patch
 * @param {string} [patch.goal] - what user asked for
 * @param {string} [patch.status] - planned | in_progress | waiting_user | done | failed
 * @param {string[]} [patch.steps] - short step log
 * @param {object} [patch.facts] - durable facts (github user, repo name, phone, etc.) — no secrets
 * @param {string} [patch.lastTool]
 * @param {string} [patch.note]
 */
function update(chatId, userId, patch = {}) {
  const k = key(chatId, userId);
  const prev = store.get(k, null) || {
    goal: '',
    status: 'planned',
    steps: [],
    facts: {},
    lastTool: null,
    note: '',
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
  const next = { ...prev, updatedAt: Date.now() };
  if (patch.goal != null) next.goal = String(patch.goal).slice(0, 800);
  if (patch.status != null) next.status = String(patch.status).slice(0, 40);
  if (patch.lastTool != null) next.lastTool = String(patch.lastTool).slice(0, 60);
  if (patch.note != null) next.note = String(patch.note).slice(0, 400);
  if (patch.facts && typeof patch.facts === 'object') {
    next.facts = { ...(next.facts || {}), ...patch.facts };
  }
  if (patch.step) {
    next.steps = Array.isArray(next.steps) ? next.steps.slice() : [];
    next.steps.push({ at: Date.now(), text: String(patch.step).slice(0, 240) });
    while (next.steps.length > 24) next.steps.shift();
  }
  if (Array.isArray(patch.steps)) {
    next.steps = patch.steps.map((t) =>
      typeof t === 'string' ? { at: Date.now(), text: t.slice(0, 240) } : t
    ).slice(-24);
  }
  if (!next.startedAt) next.startedAt = Date.now();
  store.set(k, next);
  return next;
}

function clear(chatId, userId) {
  store.delete(key(chatId, userId));
}

function markDone(chatId, userId, note) {
  return update(chatId, userId, { status: 'done', note: note || 'completed', step: note || 'done' });
}

function markFailed(chatId, userId, note) {
  return update(chatId, userId, { status: 'failed', note: note || 'failed', step: note || 'failed' });
}

/** Text block injected into the system prompt so the model never forgets mid-job. */
function contextBlock(chatId, userId) {
  const s = get(chatId, userId);
  if (!s || !s.goal) return '';
  if (s.status === 'done' && Date.now() - (s.updatedAt || 0) > 15 * 60 * 1000) return '';
  const ageMin = Math.max(0, Math.round((Date.now() - (s.startedAt || s.updatedAt || Date.now())) / 60000));
  const steps = (s.steps || []).slice(-8).map((x) => `- ${x.text || x}`).join('\n');
  const facts = s.facts && Object.keys(s.facts).length
    ? Object.entries(s.facts).map(([k, v]) => `${k}=${v}`).join('; ')
    : '';
  return `[ACTIVE WORK SESSION (~${ageMin}m)
Status: ${s.status || 'in_progress'}
Goal: ${s.goal}
${facts ? `Facts: ${facts}` : ''}
${s.lastTool ? `Last tool: ${s.lastTool}` : ''}
${s.note ? `Note: ${s.note}` : ''}
Recent steps:
${steps || '- (none logged yet)'}
RULES: Treat this session as background context, not the current request by default. Continue it only when the latest message clearly refers to this goal. If the user asks for something different, switch to that request immediately and do not steer back here. If the user returns to this goal, continue honestly without asking what they want to build again. If status is done, only re-open if the user asks for changes.]`;
}

/** Heuristic: detect a new multi-step job from user text and seed the session. */
function maybeSeedFromUser(chatId, userId, text) {
  const t = String(text || '').trim();
  if (t.length < 20) return null;
  const isJob = /\b(build|create|make|fix|deploy|push|github|website|repo|project|scaffold|host)\b/i.test(t)
    && t.split(/\s+/).length >= 6;
  if (!isJob) return null;
  const cur = get(chatId, userId);
  // Don't overwrite an in-progress job with a short follow-up
  if (cur && cur.status === 'in_progress' && t.length < 80 && !/\b(instead|new|another|forget)\b/i.test(t)) {
    return cur;
  }
  const facts = {};
  const gh = t.match(/\b(?:github(?:\s+is|\s*:)?\s+)([A-Za-z0-9_-]{2,39})\b/i)
    || t.match(/\b@([A-Za-z0-9_-]{2,39})\b/);
  if (gh) facts.githubUser = gh[1];
  const repo = t.match(/\b(?:repo(?:sitory)?|project)\s+(?:name[d]?\s+)?([A-Za-z0-9._-]{2,80})\b/i)
    || t.match(/\bname(?:d)?\s+([A-Za-z0-9._ -]{2,80})\b/i);
  if (repo) facts.repoName = repo[1].trim();
  const phones = [...t.matchAll(/\b(\d{10,15})\b/g)].map((m) => m[1]);
  if (phones[0]) facts.contactPhone = phones[0];
  if (phones[1]) facts.ownerPhone = phones[1];
  return update(chatId, userId, {
    goal: t.slice(0, 800),
    status: 'in_progress',
    step: 'user requested job',
    facts,
    note: 'seeded from user message',
  });
}

module.exports = { get, update, clear, markDone, markFailed, contextBlock, maybeSeedFromUser };
