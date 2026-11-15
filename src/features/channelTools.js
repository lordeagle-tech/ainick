'use strict';

/**
 * Channel / reaction / poll-vote helpers used by AI tools.
 * Replaces the previous compatibility stub.
 */

const logger = require('../logger');
const axios = require('axios');

async function react(sock, jid, messageId, emoji) {
  if (!sock || !jid || !messageId) return { ok: false, error: 'sock, jid and messageId required' };
  const emojiStr = String(emoji || '👍').slice(0, 8);
  try {
    await sock.sendMessage(jid, {
      react: { text: emojiStr, key: { remoteJid: jid, id: messageId } },
    });
    return { ok: true, emoji: emojiStr };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function vote(sock, jid, pollMessageId, optionName) {
  if (!sock || !jid || !pollMessageId || !optionName) {
    return { ok: false, error: 'jid, poll_message_id and option_name required' };
  }
  try {
    if (typeof sock.relayMessage === 'function') {
      await sock.sendMessage(jid, {
        pollUpdateMessage: {
          pollCreationMessageKey: { remoteJid: jid, id: pollMessageId, fromMe: false },
          vote: { selectedOptions: [Buffer.from(String(optionName))] },
        },
      });
    } else {
      await sock.sendMessage(jid, { text: `🗳️ Voted for: ${optionName}` });
    }
    return { ok: true, option: optionName };
  } catch (e) {
    try { logger.warn({ err: e.message }, 'poll vote failed'); } catch (_) {}
    return { ok: false, error: e.message };
  }
}

async function comment(sock, jid, postMessageId, text) {
  if (!sock || !jid || !text) return { ok: false, error: 'jid and text required' };
  try {
    const payload = { text: String(text).slice(0, 4000) };
    const opts = postMessageId
      ? { quoted: { key: { remoteJid: jid, id: postMessageId } } }
      : undefined;
    await sock.sendMessage(jid, payload, opts);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function postTechUpdate(sock, jid, title, body) {
  if (!sock || !jid) return { ok: false, error: 'sock and jid required' };
  const msg = `📡 *${String(title || 'Update').slice(0, 120)}*\n\n${String(body || '').slice(0, 3500)}`;
  try {
    await sock.sendMessage(jid, { text: msg });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function getTechNews(count = 3) {
  try {
    const r = await axios.get('https://hn.algolia.com/api/v1/search?tags=front_page', { timeout: 12000 });
    const hits = (r.data?.hits || []).slice(0, Math.max(1, Number(count) || 3));
    return hits.map((h) => ({
      title: h.title || h.story_title || 'Untitled',
      source: 'Hacker News',
      url: h.url || h.story_url || '',
    }));
  } catch (e) {
    return [];
  }
}

async function scrapeUrl(url) {
  try {
    const r = await axios.get(String(url), {
      timeout: 15000,
      maxContentLength: 2 * 1024 * 1024,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WaAgent/1.0)' },
      responseType: 'text',
      validateStatus: () => true,
    });
    const text = String(r.data || '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 8000);
    return { ok: true, status: r.status, text };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function webSearch(query, count = 5) {
  try {
    const websearch2 = require('./websearch2');
    if (websearch2 && typeof websearch2.browse === 'function') {
      return await websearch2.browse(query, count);
    }
  } catch (_) {}
  return [];
}

module.exports = {
  react, vote, comment, postTechUpdate, getTechNews, scrapeUrl, webSearch,
};
