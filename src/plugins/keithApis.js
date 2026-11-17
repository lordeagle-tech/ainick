'use strict';

const commandPrefix = require('./commandPrefix');
const net = require('node:net');

const API_BASE = 'https://keithhostdeploysite-22l75uk5-ff0ccc337078.herokuapp.com';
const API_TIMEOUT_MS = 15000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const menuCommands = [
  'keith api', 'keithapi', 'keithai', 'movie', 'news', 'football news', 'sports news',
  'ytsearch', 'bible', 'random verse', 'fruit', 'translate', 'shorten', 'fancy',
  'truth', 'dare', 'quote', 'fact', 'wyr', 'would you rather',
];
const COMMAND_PATTERN = /^(?:keith\s+api|keithapi|keithai\s+\S[\s\S]*|movie\s+\S[\s\S]*|ytsearch\s+\S[\s\S]*|(?:football|sports)\s+news|news(?:\s+\S[\s\S]*)?|bible(?:\s+search)?\s+\S[\s\S]*|random\s+verse|fruit\s+\S[\s\S]*|translate\s+(?:to\s+)?[a-z]{2,5}\s+\S[\s\S]*|shorten\s+\S[\s\S]*|fancy\s+\S[\s\S]*|truth|dare|quote|fact|wyr|would\s+you\s+rather)$/i;

function isCommand(input) {
  return COMMAND_PATTERN.test(commandPrefix.parseCommand(input).text.trim());
}

function queryUrl(path, params) {
  const url = new URL(path, API_BASE);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  return url;
}

async function requestJson(path, params = {}) {
  const url = queryUrl(path, params);
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`API returned HTTP ${response.status}`);
  if (!response.body) throw new Error('API returned an empty response');

  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > MAX_RESPONSE_BYTES) throw new Error('API response exceeded the size limit');
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of response.body) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_RESPONSE_BYTES) throw new Error('API response exceeded the size limit');
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString('utf8');

  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error('API returned invalid JSON');
  }
  if (data?.status === false || data?.error) {
    throw new Error(String(data.error || 'API request failed').slice(0, 240));
  }
  return data?.result ?? data;
}

function failureMessage(error) {
  const reason = String(error?.message || 'request failed').replace(/[\r\n]+/g, ' ').slice(0, 240);
  return `⚠️ Keith API request failed: ${reason}`;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function inputError(message) {
  const error = new Error(message);
  error.userInput = true;
  return error;
}

function isPrivateIpv4(hostname) {
  if (net.isIP(hostname) !== 4) return false;
  const octets = hostname.split('.').map(Number);
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127);
}

function formatMovie(result) {
  if (!result || typeof result !== 'object' || !nonEmpty(result.Title)) {
    throw new Error('No movie results were returned');
  }
  const lines = [
    `🎬 *${result.Title}*${result.Year ? ` (${result.Year})` : ''}`,
    [result.Genre, result.Runtime, result.imdbRating ? `IMDb ${result.imdbRating}` : ''].filter(Boolean).join(' · '),
    nonEmpty(result.Poster),
  ].filter(Boolean);
  return lines.join('\n');
}

function formatFootballNews(result) {
  const items = result?.data?.items;
  if (!Array.isArray(items) || !items.length) throw new Error('No sports headlines were returned');
  return `⚽ *Football news*\n${items.slice(0, 5).map((item) => {
    const title = nonEmpty(item.title) || 'Untitled';
    return `• *${title}*`;
  }).join('\n')}`;
}

function formatBibleSearch(result) {
  const verses = result?.verses;
  if (!Array.isArray(verses) || !verses.length) throw new Error('No Bible search results were returned');
  return `📖 *Bible search: ${nonEmpty(result.query) || 'results'}*\n${verses.slice(0, 5).map((verse) => {
    const reference = nonEmpty(verse.reference) || 'Verse';
    return `• *${reference}*`;
  }).join('\n')}`;
}

function formatYouTubeSearch(result) {
  if (!Array.isArray(result) || !result.length) throw new Error('No YouTube results were returned');
  return `▶️ *YouTube search*\n${result.slice(0, 5).map((item) => {
    const title = nonEmpty(item.title) || 'Untitled';
    const url = nonEmpty(item.url);
    return `• ${title}${url ? `\n  ${url}` : ''}`;
  }).join('\n')}`;
}

function formatNews(result) {
  const items = Array.isArray(result) ? result : result?.results;
  if (!Array.isArray(items) || !items.length) throw new Error('No news stories were returned');
  return `📰 *Kenyan news*\n${items.slice(0, 5).map((item) => {
    const title = nonEmpty(item.title) || 'Untitled';
    const url = nonEmpty(item.url);
    return `• *${title}*${url ? `\n  ${url}` : ''}`;
  }).join('\n')}`;
}

async function handle(ctx, text) {
  if (/^(?:keith\s+api|keithapi)$/i.test(text)) {
    return [
      '*Keith API commands*',
      '• `movie <title>` — movie details',
      '• `news [search terms]` — Kenyan headlines',
      '• `football news` — football headlines',
      '• `ytsearch <query>` — YouTube search',
      '• `bible <query>` / `random verse`',
      '• `translate <language-code> <text>`',
      '• `shorten <http(s) URL>` / `fancy <text>`',
      '• `fruit <name>` / `keithai <prompt>`',
      '• `truth`, `dare`, `quote`, `fact`, `wyr`',
      'Some upstream APIs may be temporarily unavailable.',
    ].join('\n');
  }

  const keithAi = text.match(/^keithai\s+([\s\S]+)$/i);
  if (keithAi) {
    const result = await requestJson('/keithai', { q: keithAi[1].trim().slice(0, 1000) });
    const answer = nonEmpty(typeof result === 'string' ? result : result?.answer || result?.text);
    if (!answer) throw new Error('No AI response was returned');
    return `🤖 ${answer.slice(0, 3000)}`;
  }

  const news = text.match(/^news(?:\s+([\s\S]+))?$/i);
  if (news) {
    const query = news[1]?.trim();
    const result = query
      ? await requestJson('/news/kenyans/search', { q: query.slice(0, 160) })
      : await requestJson('/news/kenyans');
    return formatNews(result);
  }

  const fruit = text.match(/^fruit\s+([\s\S]+)$/i);
  if (fruit) {
    const result = await requestJson('/education/fruit', { q: fruit[1].trim().slice(0, 100) });
    if (!result || typeof result !== 'object' || !nonEmpty(result.name)) {
      throw new Error('No fruit information was returned');
    }
    const nutrition = result.nutritions || {};
    const nutritionText = [
      nutrition.calories != null ? `${nutrition.calories} kcal` : '',
      nutrition.carbohydrates != null ? `${nutrition.carbohydrates}g carbs` : '',
      nutrition.protein != null ? `${nutrition.protein}g protein` : '',
    ].filter(Boolean).join(' · ');
    return `🍋 *${result.name}*\n${[result.family, result.genus, result.order].filter(Boolean).join(' · ')}${nutritionText ? `\nNutrition: ${nutritionText}` : ''}`;
  }

  const movie = text.match(/^movie\s+([\s\S]+)$/i);
  if (movie) {
    const result = await requestJson('/search/movie', { q: movie[1].trim().slice(0, 200) });
    return formatMovie(result);
  }

  if (/^(?:football|sports)\s+news$/i.test(text)) {
    return formatFootballNews(await requestJson('/football/news'));
  }

  const youtube = text.match(/^ytsearch\s+([\s\S]+)$/i);
  if (youtube) {
    const result = await requestJson('/search/yts', { query: youtube[1].trim().slice(0, 200) });
    return formatYouTubeSearch(result);
  }

  const bible = text.match(/^bible(?:\s+search)?\s+([\s\S]+)$/i);
  if (bible) {
    const result = await requestJson('/bible/search', { q: bible[1].trim().slice(0, 160) });
    return formatBibleSearch(result);
  }

  if (/^random\s+verse$/i.test(text)) {
    const result = await requestJson('/random/bible');
    const verse = result?.verse;
    if (!verse || !nonEmpty(verse.text)) throw new Error('No random Bible verse was returned');
    return `📖 *${verse.book} ${verse.chapter}:${verse.verse}*\n${verse.text.slice(0, 1200)}`;
  }

  const translate = text.match(/^translate\s+(?:to\s+)?([a-z]{2,5})\s+([\s\S]+)$/i);
  if (translate) {
    const language = translate[1].toLowerCase();
    const result = await requestJson('/translate', {
      text: translate[2].trim().slice(0, 1000),
      to: language,
    });
    const translated = nonEmpty(result?.translatedText);
    if (!translated) throw new Error('No translation was returned');
    return `🌐 *${language}:* ${translated.slice(0, 3000)}`;
  }

  const shorten = text.match(/^shorten\s+([\s\S]+)$/i);
  if (shorten) {
    let original;
    try {
      original = new URL(shorten[1].trim());
    } catch {
      throw inputError('Provide a valid http:// or https:// URL');
    }
    if (!['http:', 'https:'].includes(original.protocol)) {
      throw inputError('Only http:// and https:// URLs can be shortened');
    }
    const hostname = original.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (original.username || original.password
      || hostname === 'localhost'
      || hostname.endsWith('.localhost')
      || hostname.endsWith('.local')
      || hostname.endsWith('.internal')
      || isPrivateIpv4(hostname)
      || net.isIP(hostname) === 6) {
      throw inputError('Use a public website URL without credentials or a local/private address');
    }
    const result = await requestJson('/shortener/tinyurl', { url: original.href });
    const shortUrl = nonEmpty(result?.shortened);
    if (!shortUrl) throw new Error('No shortened URL was returned');
    return `🔗 ${shortUrl}`;
  }

  const fancy = text.match(/^fancy\s+([\s\S]+)$/i);
  if (fancy) {
    const result = await requestJson('/fancytext', {
      q: fancy[1].trim().slice(0, 500),
      style: 3,
    });
    const styled = nonEmpty(result?.result);
    if (!styled) throw new Error('No styled text was returned');
    return styled.slice(0, 2000);
  }

  const fun = text.match(/^(truth|dare|quote|fact|wyr|would\s+you\s+rather)$/i);
  if (fun) {
    const kind = fun[1].toLowerCase();
    const endpoint = {
      truth: '/fun/truth',
      dare: '/fun/dare',
      quote: '/fun/quote',
      fact: '/fun/fact',
      wyr: '/fun/would-you-rather',
      'would you rather': '/fun/would-you-rather',
    }[kind];
    const result = await requestJson(endpoint);
    const textResult = nonEmpty(typeof result === 'string' ? result : result?.result || result?.text);
    if (!textResult) throw new Error(`No ${kind} response was returned`);
    const label = kind === 'wyr' || kind === 'would you rather' ? 'Would you rather' : kind[0].toUpperCase() + kind.slice(1);
    return `💬 *${label}:* ${textResult.slice(0, 1000)}`;
  }

  return null;
}

async function route(ctx, input) {
  const parsed = commandPrefix.parseCommand(input);
  const text = parsed.text.trim();
  if (!isCommand(input)) return { handled: false };
  try {
    const result = await handle(ctx, text);
    return result ? { handled: true, text: result } : { handled: false };
  } catch (error) {
    if (error?.userInput) {
      return { handled: true, text: `❌ ${error.message}` };
    }
    const existingCommand = /^(?:translate|news)(?:\s|$)|^(?:truth|dare|quote|fact)$/i.test(text);
    if (existingCommand) return { handled: false };
    return { handled: true, text: failureMessage(error) };
  }
}

module.exports = { isCommand, route, menuCommands };
