'use strict';

const net = require('node:net');
const commandPrefix = require('./commandPrefix');

const REQUEST_TIMEOUT_MS = 20000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_CHARS = 20000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const menuCommands = [
  'checker',
  'subdomain', 'subdomainfinder', 'findsubs',
  'yt-monetize', 'ytmonetize', 'ytcheck',
  'ai-detect', 'aidetect', 'detectai',
  'nsfwcheck', 'nsfw-check',
];

function parsedText(input) {
  return commandPrefix.parseCommand(input).text.trim();
}

function isCommand(input) {
  return /^(?:checker|subdomain(?:finder)?|findsubs|yt-?monetize|ytcheck|ai-?detect|detectai|nsfw-?check)(?:\s|$)/i.test(parsedText(input));
}

function isNsfwCommand(input) {
  return /^nsfw-?check(?:\s|$)/i.test(parsedText(input));
}

function commandError(message) {
  return { handled: true, text: message };
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Accept: 'application/json', ...(options.headers || {}) },
  });
  const body = await response.text();
  if (body.length > MAX_RESPONSE_BYTES) throw new Error('The checker response was too large.');
  if (!response.ok) throw new Error(`The service returned HTTP ${response.status}.`);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('The checker service returned invalid JSON.');
  }
}

function validDomain(domain) {
  if (!domain || domain.length > 253 || net.isIP(domain)) return false;
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain);
}

function normalizeDomain(input) {
  let value = String(input || '').trim().replace(/^\*\./, '');
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  try {
    const url = new URL(value);
    const domain = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!validDomain(domain) || domain === 'localhost' || domain.endsWith('.localhost')) return null;
    return domain;
  } catch {
    return null;
  }
}

async function findSubdomains(rawDomain) {
  const domain = normalizeDomain(rawDomain);
  if (!domain) {
    return commandError('Usage: `subdomain domain.com` — enter a valid public domain name.');
  }
  const url = new URL('https://crt.sh/');
  url.searchParams.set('q', `%.${domain}`);
  url.searchParams.set('output', 'json');
  try {
    const records = await requestJson(url);
    if (!Array.isArray(records)) throw new Error('Unexpected certificate-transparency response.');
    const found = new Set();
    for (const record of records) {
      for (const rawName of String(record?.name_value || '').split(/\r?\n/)) {
        const hostname = rawName.trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
        if (hostname !== domain && hostname.endsWith(`.${domain}`) && validDomain(hostname)) {
          found.add(hostname);
        }
      }
    }
    const results = [...found].sort();
    if (!results.length) return commandError(`No subdomains were found in public certificate-transparency records for *${domain}*.`);
    const shown = results.slice(0, 35).map((hostname) => `• ${hostname}`).join('\n');
    const more = results.length > 35 ? `\n…and ${results.length - 35} more.` : '';
    return commandError(`*Subdomains for ${domain}*\n${results.length} unique names found in certificate-transparency records (not a live-host check).\n\n${shown}${more}`);
  } catch (error) {
    return commandError(`Subdomain lookup failed: ${error.message}`);
  }
}

function parseYouTubeTarget(rawInput) {
  const raw = String(rawInput || '').trim();
  if (!raw) return null;
  if (/^UC[A-Za-z0-9_-]{22}$/.test(raw)) return { key: 'id', value: raw };
  if (raw.startsWith('@')) return { key: 'forHandle', value: raw.slice(1) };

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return /^[A-Za-z0-9._-]{3,100}$/.test(raw) ? { key: 'forHandle', value: raw } : null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (!['youtube.com', 'm.youtube.com'].includes(host)) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0]?.startsWith('@')) return { key: 'forHandle', value: parts[0].slice(1) };
  if (parts[0] === 'channel' && /^UC[A-Za-z0-9_-]{22}$/.test(parts[1] || '')) {
    return { key: 'id', value: parts[1] };
  }
  if (parts[0] === 'user' && /^[A-Za-z0-9._-]{3,100}$/.test(parts[1] || '')) {
    return { key: 'forUsername', value: parts[1] };
  }
  return null;
}

async function checkYouTube(rawTarget) {
  const target = parseYouTubeTarget(rawTarget);
  if (!target) {
    return commandError('Usage: `ytcheck @handle` or send a YouTube channel URL or channel ID.');
  }
  const apiKey = String(process.env.YOUTUBE_API_KEY || '').trim();
  if (!apiKey) return commandError('YouTube checking needs a YouTube Data API key. Add `YOUTUBE_API_KEY` to the bot environment.');
  const url = new URL('https://www.googleapis.com/youtube/v3/channels');
  url.searchParams.set('part', 'snippet,statistics');
  url.searchParams.set(target.key, target.value);
  url.searchParams.set('key', apiKey);
  try {
    const data = await requestJson(url);
    const channel = data?.items?.[0];
    if (!channel) return commandError('No public YouTube channel matched that ID or handle.');
    const stats = channel.statistics || {};
    const title = String(channel.snippet?.title || 'YouTube channel').replace(/[\r\n*_`]/g, ' ').slice(0, 100);
    const subs = stats.hiddenSubscriberCount ? null : Number(stats.subscriberCount);
    const lines = [`*${title}*`];
    lines.push(`Subscribers: ${Number.isFinite(subs) ? `${subs.toLocaleString()} (approx.)` : 'hidden'}`);
    if (Number.isFinite(subs)) {
      lines.push(`Full-ad YPP subscriber threshold (1,000): ${subs >= 1000 ? 'met' : 'not met'}`);
    }
    lines.push('Actual monetization status: not exposed by the public channel lookup.');
    lines.push('Watch hours, Shorts eligibility, policy review, and application status must be checked in YouTube Studio.');
    return commandError(lines.join('\n'));
  } catch (error) {
    return commandError(`YouTube check failed: ${error.message}`);
  }
}

async function detectAiText(rawText, ctx = {}) {
  const text = String(rawText || ctx.quotedText || '').trim();
  if (!text) return commandError('Use `ai-detect` followed by text, or reply to a text message with `ai-detect`.');
  if (text.length > MAX_TEXT_CHARS) return commandError(`Please keep the text under ${MAX_TEXT_CHARS.toLocaleString()} characters.`);
  const apiKey = String(process.env.SAPLING_API_KEY || '').trim();
  if (!apiKey) return commandError('AI detection needs a Sapling API key. Add `SAPLING_API_KEY` to the bot environment.');
  try {
    const data = await requestJson('https://api.sapling.ai/api/v1/aidetect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: apiKey, text, sent_scores: false }),
    });
    const score = Number(data?.score);
    if (!Number.isFinite(score)) throw new Error('The detector did not return a score.');
    const verdict = ['ai', 'human', 'mixed'].includes(String(data.verdict).toLowerCase())
      ? String(data.verdict).toLowerCase()
      : 'uncertain';
    const lines = [`AI-text detector result: *${verdict}*`, `AI-likelihood score: ${Math.round(score * 100)}%`];
    if (data.low_confidence) lines.push('Low-confidence result; the text may be too short or formatted as a list.');
    if (Number.isFinite(Number(data.ai_fraction))) lines.push(`Text fraction scored as AI-like: ${Math.round(Number(data.ai_fraction) * 100)}%`);
    lines.push('This is an estimate, not proof of authorship.');
    return commandError(lines.join('\n'));
  } catch (error) {
    return commandError(`AI-text check failed: ${error.message}`);
  }
}

function safeImageMime(value) {
  const mime = String(value || '').toLowerCase().split(';')[0].trim();
  return /^image\/(?:jpeg|png|webp|gif)$/.test(mime) ? mime : 'image/jpeg';
}

async function checkNsfw(rawText, ctx = {}, imageBuffer = null) {
  const text = String(rawText || ctx.quotedText || '').trim();
  const image = Buffer.isBuffer(imageBuffer) ? imageBuffer : null;
  if (!text && !image) {
    return commandError('Use `nsfwcheck` with text, attach an image with the command, or reply to an image with `nsfwcheck`.');
  }
  if (text.length > MAX_TEXT_CHARS) return commandError(`Please keep text under ${MAX_TEXT_CHARS.toLocaleString()} characters.`);
  if (image && image.length > MAX_IMAGE_BYTES) return commandError('That image is over the 20 MB moderation limit.');
  const apiKey = String(process.env.OPENAI_MODERATION_API_KEY || process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) return commandError('NSFW checking needs an OpenAI API key. Add `OPENAI_MODERATION_API_KEY` to the bot environment.');

  const input = [];
  if (text) input.push({ type: 'text', text });
  if (image) {
    const mime = safeImageMime(ctx.imageMime || ctx.attachmentInfo?.mimetype);
    input.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${image.toString('base64')}` } });
  }
  try {
    const data = await requestJson('https://api.openai.com/v1/moderations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'omni-moderation-latest', input }),
    });
    const result = data?.results?.[0];
    if (!result) throw new Error('The moderation service returned no result.');
    const categories = result.categories || {};
    const scores = result.category_scores || {};
    const sexual = !!(categories.sexual || categories['sexual/minors']);
    const lines = [`Sexual-content signal: *${sexual ? 'detected' : 'not detected'}*`];
    if (Number.isFinite(Number(scores.sexual))) lines.push(`Model score: ${Math.round(Number(scores.sexual) * 100)}%`);
    if (categories['sexual/minors']) lines.push('A child-safety category was flagged. Do not redistribute the input.');
    else if (result.flagged && !sexual) lines.push('The moderation service flagged another safety category.');
    lines.push('Automated moderation can be wrong; treat this as a signal, not a definitive judgment.');
    return commandError(lines.join('\n'));
  } catch (error) {
    return commandError(`NSFW check failed: ${error.message}`);
  }
}

function helpText() {
  return [
    '*Checker Tools*',
    ...menuCommands.map((name) => `• \`${name}\``),
  ].join('\n');
}

async function route(ctx, input) {
  const parsed = commandPrefix.parseCommand(input);
  const text = parsed.text.trim();
  if (!isCommand(input)) return { handled: false };
  if (/^checker$/i.test(text)) return commandError(helpText());

  const subdomainMatch = text.match(/^(?:subdomain|subdomainfinder|findsubs)(?:\s+([\s\S]+))?$/i);
  if (subdomainMatch) return findSubdomains(subdomainMatch[1]);

  const youtubeMatch = text.match(/^(?:yt-monetize|ytmonetize|ytcheck)(?:\s+([\s\S]+))?$/i);
  if (youtubeMatch) {
    if (!youtubeMatch[1]) return commandError('Usage: `ytcheck @handle` or send a YouTube channel URL or channel ID.');
    return checkYouTube(youtubeMatch[1]);
  }

  const aiMatch = text.match(/^(?:ai-detect|aidetect|detectai)(?:\s+([\s\S]+))?$/i);
  if (aiMatch) return detectAiText(aiMatch[1], ctx);

  if (isNsfwCommand(text)) {
    const commandText = text.replace(/^nsfw-?check\s*/i, '').trim();
    return checkNsfw(commandText, ctx, ctx.imageBuffer || ctx.quotedImageBuffer || null);
  }
  return { handled: false };
}

async function handleMedia(ctx, input, imageBuffer) {
  if (!isNsfwCommand(input)) return { handled: false };
  const parsed = commandPrefix.parseCommand(input);
  const text = parsed.text.trim();
  const commandText = text.replace(/^nsfw-?check\s*/i, '').trim();
  return checkNsfw(commandText, ctx, imageBuffer);
}

module.exports = { isCommand, isNsfwCommand, route, handleMedia, menuCommands };
