// training.js — lightweight interaction learning.
// Learns per-user style, common requests, preferred language, and short facts
// from real chat turns. Injected into the system prompt as a compact summary.
// No external ML — durable JSON via Collection.
const { Collection } = require('../db');
const logger = require('../logger');

const store = new Collection('user_training', {});
const MAX_FACTS = 40;
const MAX_PHRASES = 30;
const MAX_STYLE_SAMPLES = 12;

function blank(userId) {
  return {
    userId: String(userId || ''),
    style: {
      avgLen: 0,
      samples: 0,
      emojiHeavy: 0,
      shortReplies: 0,
      casual: 0,
    },
    language: null, // e.g. 'en', 'pidgin', 'mixed'
    facts: [], // { text, at, hits }
    phrases: [], // frequent user phrases { text, hits }
    likes: [], // things they ask for often
    lastTrained: 0,
  };
}

function get(userId) {
  const id = String(userId || '').replace(/\D/g, '') || String(userId || '');
  if (!id) return blank('');
  return { ...blank(id), ...(store.get(id, {}) || {}) };
}

function save(userId, data) {
  const id = String(userId || '').replace(/\D/g, '') || String(userId || '');
  if (!id) return;
  data.userId = id;
  data.lastTrained = Date.now();
  store.set(id, data);
}

function detectLanguage(text) {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return null;
  // Very light heuristics for this bot's audience
  if (/\b(abeg|wetin|dey|sha|naija|jare|no wahala|how far|gimme|lmfao|fr\b|ngl)\b/i.test(t)) return 'pidgin-casual';
  if (/[\u00C0-\u024F]/.test(t) && /\b(je|tu|oui|non|merci)\b/i.test(t)) return 'fr';
  return 'en';
}

function isCasual(text) {
  return /\b(lol|lmao|fr|ngl|bro|sis|fam|abeg|sha|wetin|sup|wsg|gtg|idk|ikr)\b/i.test(text)
    || (text.length < 40 && /[!?]{2,}|\p{Emoji}/u.test(text));
}

function extractFactCandidates(text) {
  const t = String(text || '').trim();
  const out = [];
  // "my name is X", "call me X", "I prefer X", "I'm from X"
  const patterns = [
    /\b(?:my name is|i am|i'm|call me|i go by)\s+([A-Za-z][A-Za-z0-9_\- ]{1,30})/i,
    /\b(?:i (?:live|stay) in|i'm from|im from)\s+([A-Za-z0-9 ,\-]{2,40})/i,
    /\b(?:i prefer|prefer|always use|use)\s+([A-Za-z0-9 #+\-]{2,40})/i,
    /\b(?:don't|dont|never)\s+(?:call me|say|do)\s+([A-Za-z0-9 ]{2,40})/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) out.push(m[0].slice(0, 80));
  }
  return out;
}

function extractLike(text) {
  const t = String(text || '').toLowerCase();
  const likes = [];
  if (/\b(image|logo|edit|picture|photo|pp)\b/.test(t)) likes.push('images');
  if (/\b(music|song|play|lyrics)\b/.test(t)) likes.push('music');
  if (/\b(code|build|website|zip|fix)\b/.test(t)) likes.push('coding');
  if (/\b(group|kick|promote|admin|antilink|mute)\b/.test(t)) likes.push('group-admin');
  if (/\b(dm|message|text)\b/.test(t)) likes.push('dms');
  return likes;
}

function bumpList(list, text, max) {
  const key = String(text || '').trim().slice(0, 80);
  if (!key) return list;
  const existing = list.find((x) => x.text.toLowerCase() === key.toLowerCase());
  if (existing) {
    existing.hits = (existing.hits || 1) + 1;
    existing.at = Date.now();
  } else {
    list.push({ text: key, hits: 1, at: Date.now() });
  }
  list.sort((a, b) => (b.hits || 0) - (a.hits || 0) || (b.at || 0) - (a.at || 0));
  return list.slice(0, max);
}

/**
 * Observe a user message and update durable training profile.
 * @param {string} userId - phone or stable id
 * @param {string} message - user text
 * @param {object} [meta]
 */
function observe(userId, message, meta = {}) {
  try {
    if (!userId || !message) return get(userId);
    const data = get(userId);
    const text = String(message).slice(0, 500);
    const len = text.length;

    // Style running averages
    const s = data.style || blank(userId).style;
    s.samples = (s.samples || 0) + 1;
    s.avgLen = ((s.avgLen || 0) * (s.samples - 1) + len) / s.samples;
    if (/\p{Emoji}/u.test(text)) s.emojiHeavy = (s.emojiHeavy || 0) + 1;
    if (len < 25) s.shortReplies = (s.shortReplies || 0) + 1;
    if (isCasual(text)) s.casual = (s.casual || 0) + 1;
    data.style = s;

    const lang = detectLanguage(text);
    if (lang) data.language = lang;

    for (const fact of extractFactCandidates(text)) {
      data.facts = bumpList(data.facts || [], fact, MAX_FACTS);
    }
    // Keep a few short phrase fingerprints
    if (len > 2 && len < 60) {
      data.phrases = bumpList(data.phrases || [], text, MAX_PHRASES);
    }
    for (const like of extractLike(text)) {
      data.likes = bumpList(data.likes || [], like, 20);
    }

    save(userId, data);
    return data;
  } catch (e) {
    logger.warn({ err: e.message }, 'training.observe failed');
    return get(userId);
  }
}

/**
 * Observe bot reply quality signal: if user says "good"/"wrong"/"wack" etc.
 */
function observeFeedback(userId, message) {
  const t = String(message || '').toLowerCase();
  const data = get(userId);
  if (/\b(good|perfect|nice|thanks|thank you|correct|exactly|love it)\b/.test(t)) {
    data.facts = bumpList(data.facts || [], 'User often approves short direct answers', MAX_FACTS);
  }
  if (/\b(wack|wrong|bad|no|not that|try again|fix it|useless)\b/.test(t)) {
    data.facts = bumpList(data.facts || [], 'User rejects vague answers — be precise and use tools', MAX_FACTS);
  }
  save(userId, data);
  return data;
}

/**
 * Compact prompt block for the system message.
 */
function promptBlock(userId) {
  const data = get(userId);
  if (!data || !(data.style?.samples > 2)) return '';

  const lines = ['Learned about this user (from past chats — adapt, do not recite raw):'];
  const s = data.style;
  const n = s.samples || 1;
  if (s.avgLen && s.avgLen < 40) lines.push('- Prefers short replies.');
  if (s.avgLen && s.avgLen > 120) lines.push('- Often writes longer messages — can handle detailed answers.');
  if ((s.casual || 0) / n > 0.35) lines.push('- Casual tone; match slang lightly, stay useful.');
  if ((s.emojiHeavy || 0) / n > 0.25) lines.push('- Comfortable with emojis; use sparingly.');
  if (data.language === 'pidgin-casual') lines.push('- Often uses Nigerian Pidgin / casual EN — understand it; reply clearly.');
  if (data.language && data.language !== 'en' && data.language !== 'pidgin-casual') {
    lines.push(`- Language lean: ${data.language}.`);
  }
  const topLikes = (data.likes || []).slice(0, 4).map((x) => x.text);
  if (topLikes.length) lines.push(`- Often asks about: ${topLikes.join(', ')}.`);
  const topFacts = (data.facts || []).slice(0, 6).map((x) => x.text);
  for (const f of topFacts) lines.push(`- ${f}`);

  if (lines.length <= 1) return '';
  return '\n\n' + lines.join('\n');
}

module.exports = {
  observe,
  observeFeedback,
  promptBlock,
  get,
  save,
};
