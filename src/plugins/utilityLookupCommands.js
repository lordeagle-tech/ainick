'use strict';

// Public lookup utilities: FX rates, country data, GitHub profiles/repos,
// crypto conversion/news, and the installed Baileys version.

const path = require('node:path');
const axios = require('axios');
const commandPrefix = require('./commandPrefix');

const UA = 'NickAI (https://github.com/lordeagle-tech/ainick)';
const API_TIMEOUT_MS = 15000;

// REST Countries v1-v3 was retired in 2026 and v5 needs an API key, so country
// lookups use Wikidata (keyless) instead.
const WD_PROPS = {
  population: 'P1082',
  callingCode: 'P474',
  alpha2: 'P297',
  alpha3: 'P298',
  capital: 'P36',
  continent: 'P30',
  language: 'P37',
  currency: 'P38',
  flag: 'P41',
};

const menuCommands = [
  'currency',
  'country', 'callingcode', 'population',
  'cryptoconvert', 'cryptonews',
  'baileysversion',
];
const publicGithubMenuCommands = ['gh user', 'github user/repo'];

const COMMON_CURRENCIES = ['USD', 'EUR', 'GBP', 'KES', 'NGN', 'GHS', 'ZAR', 'UGX', 'TZS', 'JPY', 'CNY', 'AUD', 'CAD', 'INR'];
const FIAT_CODES = new Set([
  ...COMMON_CURRENCIES,
  'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'RON', 'BRL', 'MXN',
  'SGD', 'HKD', 'KRW', 'NZD', 'TRY', 'AED', 'SAR', 'PHP', 'IDR', 'MYR',
  'THB', 'VND', 'UAH', 'ARS', 'CLP', 'COP', 'PEN', 'PKR', 'BDT', 'LKR',
]);

// Small symbol map keeps `cryptoconvert` fast and avoids a huge /coins/list download.
const COINS = {
  btc: { id: 'bitcoin', symbol: 'BTC' },
  eth: { id: 'ethereum', symbol: 'ETH' },
  sol: { id: 'solana', symbol: 'SOL' },
  bnb: { id: 'binancecoin', symbol: 'BNB' },
  xrp: { id: 'ripple', symbol: 'XRP' },
  ada: { id: 'cardano', symbol: 'ADA' },
  doge: { id: 'dogecoin', symbol: 'DOGE' },
  avax: { id: 'avalanche-2', symbol: 'AVAX' },
  dot: { id: 'polkadot', symbol: 'DOT' },
  matic: { id: 'matic-network', symbol: 'MATIC' },
  ltc: { id: 'litecoin', symbol: 'LTC' },
  trx: { id: 'tron', symbol: 'TRX' },
  link: { id: 'chainlink', symbol: 'LINK' },
  atom: { id: 'cosmos', symbol: 'ATOM' },
  xlm: { id: 'stellar', symbol: 'XLM' },
  uni: { id: 'uniswap', symbol: 'UNI' },
  near: { id: 'near', symbol: 'NEAR' },
  ape: { id: 'apecoin', symbol: 'APE' },
  shib: { id: 'shiba-inu', symbol: 'SHIB' },
  ton: { id: 'the-open-network', symbol: 'TON' },
  usdt: { id: 'tether', symbol: 'USDT' },
  usdc: { id: 'usd-coin', symbol: 'USDC' },
  dai: { id: 'dai', symbol: 'DAI' },
};
const COIN_SYMBOLS = new Set(Object.values(COINS).map((coin) => coin.symbol));
const GITHUB_RESERVED = new Set(['status', 'disconnect', 'clone', 'connect']);

function parsedText(input) {
  return commandPrefix.parseCommand(input).text.trim();
}

function isCommand(input) {
  return /^(?:currency|country|callingcode|population|gh|github|cryptoconvert|cryptonews|baileysversion)(?:\s|$)/i.test(parsedText(input));
}

function safe(value, limit = 180) {
  return String(value || '').replace(/[\r\n`*_~]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function codeSafe(value, limit = 200) {
  return String(value || '').replace(/[\r\n`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function formatWhole(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number).toLocaleString('en-US') : 'unknown';
}

function formatDecimal(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 'unknown';
  const abs = Math.abs(number);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : abs >= 0.01 ? 6 : 10;
  return number.toLocaleString('en-US', { maximumFractionDigits: digits });
}

async function requestJson(url, headers = {}) {
  const response = await axios.get(url, {
    timeout: API_TIMEOUT_MS,
    maxContentLength: 4 * 1024 * 1024,
    validateStatus: () => true,
    headers: { Accept: 'application/json', 'User-Agent': UA, ...headers },
  });
  if (response.status < 200 || response.status >= 300) {
    if (response.status === 404) throw new Error('not found');
    if (response.status === 403 || response.status === 429) throw new Error('API rate limit reached — try again shortly.');
    throw new Error(`API returned HTTP ${response.status}`);
  }
  return response.data;
}

function currencyUsage() {
  return [
    '╭─〘 *💱 CURRENCY* 〙',
    '┃❍ Convert: `currency 100 USD KES`',
    '┃❍ Alias form: `currency 100 USD to KES`',
    '┃❍ Rates: `currency USD`',
    `┃❍ Common: ${COMMON_CURRENCIES.join(', ')}`,
    '╰──────────⊷',
  ].join('\n');
}

async function currencyCommand(raw) {
  const cleaned = String(raw || '').trim().toUpperCase().replace(/[→=]/g, ' to ');
  const parts = cleaned.split(/\s+/).filter((part) => part && part !== 'TO' && part !== 'IN');
  if (!parts.length) return { handled: true, text: currencyUsage() };

  let amount = 1;
  let base = parts[0];
  if (/^\d+(?:\.\d+)?$/.test(parts[0])) {
    amount = Number(parts[0]);
    base = parts[1];
  }
  const quote = amount === 1 && !/^\d+(?:\.\d+)?$/.test(parts[0]) ? parts[1] : parts[2];
  if (!base || !/^[A-Z]{3}$/.test(base)) return { handled: true, text: currencyUsage() };
  if (quote && !/^[A-Z]{3}$/.test(quote)) return { handled: true, text: currencyUsage() };
  if (amount <= 0 || amount > 1e12) return { handled: true, text: '❌ Use an amount between 0 and 1,000,000,000,000.' };

  try {
    const data = await requestJson(`https://open.er-api.com/v6/latest/${encodeURIComponent(base)}`);
    if (data?.result !== 'success' || !data?.rates) throw new Error(`No rates returned for ${base}.`);
    const rates = data.rates;
    const updated = safe(data.time_last_update_utc || data.time_last_update_unix || 'recent', 80);

    if (!quote) {
      const lines = ['╭─〘 *💱 LIVE RATES* 〙', `┃❍ *Base:* ${base}`, '┃'];
      for (const code of COMMON_CURRENCIES) {
        if (code === base || rates[code] == null) continue;
        lines.push(`┃❍ *${code}:* ${formatDecimal(rates[code])}`);
      }
      if (lines.length === 3) lines.push('┃❍ No common rates were returned for that base.');
      lines.push('┃', `┃❍ _Updated: ${updated}_`, '┃❍ Source: ExchangeRate-API', '╰──────────⊷');
      return { handled: true, text: lines.join('\n') };
    }

    const rate = Number(rates[quote]);
    if (!Number.isFinite(rate)) return { handled: true, text: `❌ Cannot convert ${base} → ${quote}. Check the currency codes.` };
    const result = amount * rate;
    return { handled: true, text: [
      '╭─〘 *💱 CURRENCY CONVERTER* 〙',
      '┃',
      `┃❍ *${formatDecimal(amount)} ${base}* = *${formatDecimal(result)} ${quote}*`,
      `┃❍ 1 ${base} = ${formatDecimal(rate)} ${quote}`,
      '┃',
      `┃❍ _Updated: ${updated}_`,
      '┃❍ Source: ExchangeRate-API',
      '╰──────────⊷',
    ].join('\n') };
  } catch (error) {
    return { handled: true, text: `❌ ${safe(error.message, 240)}` };
  }
}

function countryUsage(mode) {
  const label = mode === 'population' ? 'POPULATION' : 'COUNTRY LOOKUP';
  return [
    `╭─〘 *🌍 ${label}* 〙`,
    '┃❍ `country kenya` · `country KE` · `country 254`',
    '┃❍ `callingcode 254` · `population kenya`',
    '╰──────────⊷',
  ].join('\n');
}

async function wikidataApi(params) {
  const url = new URL('https://www.wikidata.org/w/api.php');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return requestJson(url.toString());
}

async function wikidataSparql(query) {
  const url = `https://query.wikidata.org/sparql?query=${encodeURIComponent(query)}&format=json`;
  return requestJson(url, { Accept: 'application/sparql-results+json' });
}

function claimValues(entity, prop) {
  return (entity?.claims?.[prop] || [])
    .map((claim) => claim?.mainsnak?.datavalue?.value)
    .filter((value) => value !== undefined && value !== null);
}

function qidsFrom(entity, prop) {
  return claimValues(entity, prop)
    .map((value) => (typeof value === 'object' && value.id ? value.id : value?.['numeric-id'] ? `Q${value['numeric-id']}` : ''))
    .filter(Boolean);
}

function flagEmoji(code) {
  const alpha2 = String(code || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(alpha2)) return '';
  return [...alpha2].map((char) => String.fromCodePoint(127397 + char.charCodeAt(0))).join('');
}

function populationOf(entity) {
  const claims = entity?.claims?.[WD_PROPS.population] || [];
  const ranked = claims.map((claim) => {
    const amount = Number(String(claim?.mainsnak?.datavalue?.value?.amount || '').replace(/^\+/, ''));
    const timeValue = claim?.qualifiers?.P585?.[0]?.datavalue?.value?.time;
    const time = timeValue ? Date.parse(String(timeValue).replace(/^\+/, '')) || 0 : 0;
    const rank = claim?.rank === 'preferred' ? 2 : claim?.rank === 'normal' ? 1 : 0;
    return { amount, time, rank };
  }).filter((item) => Number.isFinite(item.amount) && item.amount > 0);
  ranked.sort((a, b) => b.time - a.time || b.rank - a.rank || b.amount - a.amount);
  return ranked[0]?.amount || 0;
}

function normalizeCountry(entity, labels) {
  const label = entity?.labels?.en?.value || labels[entity?.id] || `Country ${entity?.id || '?'}`;
  const alpha2 = String(claimValues(entity, WD_PROPS.alpha2)[0] || '').toUpperCase();
  const alpha3 = String(claimValues(entity, WD_PROPS.alpha3)[0] || '').toUpperCase();
  const call = String(claimValues(entity, WD_PROPS.callingCode)[0] || '').trim();
  const flagName = String(claimValues(entity, WD_PROPS.flag)[0] || '').trim();
  const labelFor = (prop) => qidsFrom(entity, WD_PROPS[prop]).map((id) => labels[id]).filter(Boolean);
  const currencyNames = labelFor('currency');
  const flagUrl = flagName
    ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(flagName.replace(/ /g, '_'))}?width=240`
    : '';

  return {
    name: { common: label, official: label },
    cca2: alpha2,
    cca3: alpha3,
    idd: call ? { root: '+', suffixes: [call.replace(/^\+/, '')] } : { root: '', suffixes: [] },
    population: populationOf(entity),
    capital: labelFor('capital'),
    region: labelFor('continent').join(', '),
    subregion: '',
    currencies: Object.fromEntries(currencyNames.map((name) => [name, { name, code: '' }])),
    languages: labelFor('language'),
    flags: { emoji: flagEmoji(alpha2), png: flagUrl },
  };
}

async function loadCountries(ids) {
  const unique = [...new Set(ids)].slice(0, 12);
  if (!unique.length) return [];
  const data = await wikidataApi({
    action: 'wbgetentities',
    ids: unique.join('|'),
    props: 'labels|claims',
    languages: 'en',
    format: 'json',
  });
  const entities = Object.values(data?.entities || {}).filter((entity) => entity?.claims);
  const linked = new Set();
  for (const entity of entities) {
    for (const prop of ['capital', 'continent', 'language', 'currency']) {
      for (const id of qidsFrom(entity, WD_PROPS[prop])) linked.add(id);
    }
  }
  let labels = {};
  if (linked.size) {
    const labelData = await wikidataApi({
      action: 'wbgetentities',
      ids: [...linked].slice(0, 60).join('|'),
      props: 'labels',
      languages: 'en',
      format: 'json',
    });
    for (const [id, entity] of Object.entries(labelData?.entities || {})) {
      labels[id] = entity?.labels?.en?.value || '';
    }
  }
  return entities.map((entity) => normalizeCountry(entity, labels)).filter((country) => country.name.common);
}

async function findCountryIds(raw) {
  const input = String(raw || '').trim();
  if (/^\+?\d+$/.test(input)) {
    const code = input.replace(/\D/g, '');
    const query = `SELECT DISTINCT ?country WHERE { ?country wdt:P31/wdt:P279* wd:Q6256; wdt:P474 ?call. FILTER(STR(?call)="+${code}") } LIMIT 12`;
    const data = await wikidataSparql(query);
    return {
      mode: 'callingcode',
      ids: (data?.results?.bindings || []).map((row) => row.country?.value?.split('/').pop()).filter(Boolean),
    };
  }
  if (/^[A-Za-z]{2}$/.test(input)) {
    const query = `SELECT DISTINCT ?country WHERE { ?country wdt:P31/wdt:P279* wd:Q6256; wdt:P297 "${input.toUpperCase()}". } LIMIT 3`;
    const data = await wikidataSparql(query);
    return {
      mode: 'alpha',
      ids: (data?.results?.bindings || []).map((row) => row.country?.value?.split('/').pop()).filter(Boolean),
    };
  }
  const data = await wikidataApi({
    action: 'wbsearchentities',
    search: input.slice(0, 120),
    language: 'en',
    format: 'json',
    limit: 8,
    type: 'item',
  });
  const candidates = data?.search || [];
  const preferred = candidates.find((item) => /country|state|nation|republic|kingdom/i.test(String(item.description || ''))) || candidates[0];
  return { mode: 'name', ids: preferred ? [preferred.id] : [] };
}

function callingCodeOf(country) {
  const root = country?.idd?.root || '';
  const suffixes = Array.isArray(country?.idd?.suffixes) ? country.idd.suffixes : [];
  if (!root) return 'unknown';
  if (!suffixes.length) return root;
  return suffixes.slice(0, 3).map((suffix) => `${root}${suffix}`).join(', ');
}

function countryCard(country) {
  const name = country?.name?.common || country?.name?.official || 'Unknown';
  const lines = [
    `${country?.flags?.emoji || '🌍'} *${safe(name, 100)}*`,
    `• Code: ${codeSafe(country?.cca2 || '?')} / ${codeSafe(country?.cca3 || '?')} · Calling: ${codeSafe(callingCodeOf(country), 60)}`,
  ];
  if (country?.capital?.length) lines.push(`• Capital: ${safe(country.capital.slice(0, 3).join(', '), 100)}`);
  lines.push(`• Region: ${safe([country?.region, country?.subregion].filter(Boolean).join(' · '), 120)}`);
  lines.push(`• Population: ${formatWhole(country?.population)}`);
  const currencies = country?.currencies ? Object.values(country.currencies).map((currency) => currency.name || currency.code).filter(Boolean) : [];
  if (currencies.length) lines.push(`• Currency: ${safe(currencies.slice(0, 3).join(', '), 120)}`);
  const languages = country?.languages ? Object.values(country.languages).slice(0, 5) : [];
  if (languages.length) lines.push(`• Languages: ${safe(languages.join(', '), 140)}`);
  if (country?.flags?.png) lines.push(`• Flag: ${codeSafe(country.flags.png, 220)}`);
  return lines.join('\n');
}

function populationCard(country) {
  const name = country?.name?.common || country?.name?.official || 'Unknown';
  return [
    `🌍 *Population · ${safe(name, 100)}*`,
    `• Population: ${formatWhole(country?.population)}`,
    `• Region: ${safe([country?.region, country?.subregion].filter(Boolean).join(' · '), 120)}`,
    `• Calling code: ${codeSafe(callingCodeOf(country), 60)}`,
  ].join('\n');
}

async function countryCommand(raw, mode = 'country') {
  if (!raw) return { handled: true, text: countryUsage(mode) };
  try {
    const found = await findCountryIds(raw);
    if (!found.ids.length) return { handled: true, text: `❌ No country found for \`${codeSafe(raw, 80)}\`.` };
    const countries = await loadCountries(found.ids);
    if (!countries.length) return { handled: true, text: `❌ No country found for \`${codeSafe(raw, 80)}\`.` };

    if (mode === 'population') return { handled: true, text: populationCard(countries[0]) };
    if (found.mode === 'callingcode') {
      const lines = [`📞 *Calling code +${codeSafe(String(raw).replace(/\D/g, ''), 10)}*`, ''];
      for (const country of countries.slice(0, 12)) {
        lines.push(`• ${country.flags?.emoji || '🌍'} ${safe(country.name.common, 70)} · ${codeSafe(country.cca2 || '?')}`);
      }
      if (countries.length > 12) lines.push(`• …and ${countries.length - 12} more`);
      return { handled: true, text: lines.join('\n') };
    }
    return { handled: true, text: countryCard(countries[0]) };
  } catch (error) {
    if (safe(error.message) === 'not found') {
      return { handled: true, text: `❌ No country found for \`${codeSafe(raw, 80)}\`. Try a name, 2-letter code, or calling code.` };
    }
    return { handled: true, text: `❌ Country lookup failed: ${safe(error.message, 240)}` };
  }
}

function normalizeGitHubTarget(raw) {
  let target = String(raw || '').trim().replace(/\s+/g, '').replace(/\/+$/, '');
  if (!target) return { error: 'Usage: `gh octocat` or `gh octocat/Hello-World`.' };
  if (/^https?:\/\//i.test(target)) {
    let url;
    try { url = new URL(target); } catch { return { error: 'That GitHub link is invalid.' }; }
    if (!/^(?:www\.)?github\.com$/i.test(url.hostname)) return { error: 'Only github.com links are supported.' };
    target = url.pathname.split('/').filter(Boolean).slice(0, 2).join('/');
  }
  if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?$/.test(target)) {
    return { error: 'Use `gh username` or `gh owner/repo`.' };
  }
  if (target.includes('/')) {
    const [owner, repo] = target.split('/');
    return { kind: 'repo', owner, repo, url: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` };
  }
  return { kind: 'user', user: target, url: `/users/${encodeURIComponent(target)}` };
}

function formatGithubUser(user) {
  return [
    `🐙 *GitHub · ${safe(user.login, 100)}*`,
    user.name ? `• Name: ${safe(user.name, 100)}` : null,
    user.bio ? `• Bio: ${safe(user.bio, 240)}` : null,
    `• Followers: ${formatWhole(user.followers)} · Following: ${formatWhole(user.following)}`,
    `• Public repos: ${formatWhole(user.public_repos)} · Gists: ${formatWhole(user.public_gists)}`,
    user.location ? `• Location: ${safe(user.location, 100)}` : null,
    user.blog ? `• Website: ${codeSafe(user.blog, 180)}` : null,
    `• Joined: ${safe(String(user.created_at || '').slice(0, 10), 20)}`,
    `• Profile: ${codeSafe(user.html_url, 220)}`,
  ].filter(Boolean).join('\n');
}

function formatGithubRepo(repo) {
  return [
    `📦 *GitHub · ${safe(repo.full_name, 140)}*`,
    repo.description ? `• ${safe(repo.description, 300)}` : '• No description provided.',
    `• ⭐ ${formatWhole(repo.stargazers_count)} · 🍴 ${formatWhole(repo.forks_count)} · 👁 ${formatWhole(repo.watchers_count)}`,
    `• Open issues: ${formatWhole(repo.open_issues_count)} · Language: ${safe(repo.language || 'not specified', 60)}`,
    `• Default branch: ${codeSafe(repo.default_branch || 'unknown', 80)}`,
    `• License: ${safe(repo.license?.spdx_id || repo.license?.name || 'none', 80)}`,
    `• Updated: ${safe(String(repo.updated_at || '').slice(0, 10), 20)}`,
    `• Link: ${codeSafe(repo.html_url, 220)}`,
  ].join('\n');
}

async function githubLookupCommand(command, raw) {
  if (!raw || GITHUB_RESERVED.has(String(raw).trim().split(/\s+/)[0].toLowerCase())) return { handled: false };
  const target = normalizeGitHubTarget(raw);
  if (target.error) return { handled: true, text: target.error };
  try {
    const data = await requestJson(`https://api.github.com${target.url}`, {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    });
    return { handled: true, text: target.kind === 'user' ? formatGithubUser(data) : formatGithubRepo(data) };
  } catch (error) {
    if (safe(error.message) === 'not found') return { handled: true, text: `❌ GitHub ${target.kind} not found.` };
    return { handled: true, text: `❌ GitHub lookup failed: ${safe(error.message, 240)}` };
  }
}

function coinOrFiat(token) {
  const raw = String(token || '').trim().toUpperCase();
  const coin = COINS[raw.toLowerCase()] || Object.values(COINS).find((entry) => entry.symbol === raw);
  if (coin) return { kind: 'crypto', ...coin };
  if (FIAT_CODES.has(raw)) return { kind: 'fiat', code: raw, symbol: raw };
  return null;
}

async function coingeckoPrice(ids, currencies) {
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=${encodeURIComponent(currencies)}`;
  const data = await requestJson(url);
  if (!data || typeof data !== 'object') throw new Error('No price data returned.');
  return data;
}

async function conversionRate(from, to) {
  if (from.kind === 'fiat' && to.kind === 'fiat') {
    const data = await requestJson(`https://open.er-api.com/v6/latest/${encodeURIComponent(from.code)}`);
    if (data?.result !== 'success') throw new Error(`No FX rate for ${from.code}.`);
    const rate = Number(data?.rates?.[to.code]);
    if (!Number.isFinite(rate)) throw new Error(`Cannot convert ${from.code} → ${to.code}.`);
    return rate;
  }
  if (from.kind === 'crypto' && to.kind === 'fiat') {
    const prices = await coingeckoPrice(from.id, to.code.toLowerCase());
    const rate = Number(prices?.[from.id]?.[to.code.toLowerCase()]);
    if (!Number.isFinite(rate)) throw new Error(`No ${from.symbol}/${to.code} price available.`);
    return rate;
  }
  if (from.kind === 'fiat' && to.kind === 'crypto') {
    const prices = await coingeckoPrice(to.id, from.code.toLowerCase());
    const rate = Number(prices?.[to.id]?.[from.code.toLowerCase()]);
    if (!Number.isFinite(rate) || rate === 0) throw new Error(`No ${to.symbol}/${from.code} price available.`);
    return 1 / rate;
  }
  const prices = await coingeckoPrice(`${from.id},${to.id}`, 'usd');
  const fromUsd = Number(prices?.[from.id]?.usd);
  const toUsd = Number(prices?.[to.id]?.usd);
  if (!Number.isFinite(fromUsd) || !Number.isFinite(toUsd) || toUsd === 0) {
    throw new Error(`No USD price available for ${from.symbol} or ${to.symbol}.`);
  }
  return fromUsd / toUsd;
}

async function cryptoConvertCommand(raw) {
  const cleaned = String(raw || '').trim().toUpperCase().replace(/[→=]/g, ' to ');
  const parts = cleaned.split(/\s+/).filter((part) => part && part !== 'TO' && part !== 'IN');
  if (!parts.length) {
    return { handled: true, text: [
      '╭─〘 *🪙 CRYPTO CONVERT* 〙',
      '┃❍ `cryptoconvert 1 BTC to USD`',
      `┃❍ Coins: ${[...COIN_SYMBOLS].slice(0, 12).join(', ')}, …`,
      '┃❍ Fiat: USD, KES, EUR, GBP, NGN, …',
      '╰──────────⊷',
    ].join('\n') };
  }

  let amount = 1;
  let fromToken = parts[0];
  let toToken = parts[1];
  if (/^\d+(?:\.\d+)?$/.test(parts[0])) {
    amount = Number(parts[0]);
    fromToken = parts[1];
    toToken = parts[2];
  }
  const from = coinOrFiat(fromToken);
  const to = coinOrFiat(toToken);
  if (!from || !to || amount <= 0 || amount > 1e15) {
    return { handled: true, text: '❌ Usage: `cryptoconvert 1 BTC to USD` (use a supported coin/fiat code).' };
  }
  if (from.kind === to.kind && from.kind === 'crypto' && from.id === to.id) {
    return { handled: true, text: `❌ Nothing to convert: ${from.symbol} → ${to.symbol}.` };
  }

  try {
    const rate = await conversionRate(from, to);
    const result = amount * rate;
    return { handled: true, text: [
      '╭─〘 *🪙 CRYPTO CONVERT* 〙',
      '┃',
      `┃❍ *${formatDecimal(amount)} ${from.symbol}* = *${formatDecimal(result)} ${to.symbol}*`,
      `┃❍ 1 ${from.symbol} = ${formatDecimal(rate)} ${to.symbol}`,
      '┃',
      '┃❍ Prices: CoinGecko / ExchangeRate-API',
      '╰──────────⊷',
    ].join('\n') };
  } catch (error) {
    return { handled: true, text: `❌ Crypto conversion failed: ${safe(error.message, 240)}` };
  }
}

function decodeXml(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function tagValue(block, tag) {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? decodeXml(match[1]) : '';
}

async function cryptoNewsCommand() {
  try {
    const response = await axios.get('https://www.coindesk.com/arc/outboundfeeds/rss/', {
      timeout: API_TIMEOUT_MS,
      maxContentLength: 2 * 1024 * 1024,
      validateStatus: () => true,
      headers: { Accept: 'application/rss+xml, application/xml, text/xml', 'User-Agent': UA },
    });
    if (response.status < 200 || response.status >= 300) throw new Error(`RSS returned HTTP ${response.status}`);
    const items = String(response.data || '').match(/<item>[\s\S]*?<\/item>/gi) || [];
    if (!items.length) throw new Error('No headlines were returned.');
    const lines = ['📰 *Crypto news · CoinDesk*', ''];
    for (const item of items.slice(0, 6)) {
      const title = tagValue(item, 'title') || 'Untitled';
      const link = tagValue(item, 'link');
      const date = tagValue(item, 'pubDate');
      lines.push(`• *${safe(title, 180)}*`);
      if (date) lines.push(`  ${safe(new Date(date).toUTCString(), 60)}`);
      if (link) lines.push(`  ${codeSafe(link, 220)}`);
    }
    return { handled: true, text: lines.join('\n') };
  } catch (error) {
    return { handled: true, text: `❌ Crypto news failed: ${safe(error.message, 240)}` };
  }
}

function tryRequire(target) {
  try { return require(target); } catch { return null; }
}

async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function baileysVersionCommand() {
  const pkg = tryRequire('@lordeagle21/baileys/package.json');
  let rootPkg = null;
  try { rootPkg = require(path.join(process.cwd(), 'package.json')); } catch {}
  const declared = rootPkg?.dependencies?.['@lordeagle21/baileys'] || 'unknown';

  let waVersion = '';
  try {
    const baileys = tryRequire('@lordeagle21/baileys');
    if (baileys?.fetchLatestBaileysVersion) {
      const result = await withTimeout(baileys.fetchLatestBaileysVersion(), 2500);
      const version = Array.isArray(result?.version) ? result.version.join('.') : String(result?.version || '');
      if (version) waVersion = `${version}${result?.isLatest === false ? ' (outdated ⚠️)' : ' (latest ✅)'}`;
    }
  } catch {}

  const repository = typeof pkg?.repository === 'string' ? pkg.repository : pkg?.repository?.url;
  const gitUrl = String(repository || '').replace(/^git\+/, '').replace(/\.git$/, '');
  const lines = [
    '╭─〘 *📦 BAILEYS VERSION* 〙',
    '┃',
    `┃❍ Library: ${codeSafe(pkg?.name || '@lordeagle21/baileys', 100)}`,
    `┃❍ Installed: v${codeSafe(pkg?.version || 'unknown', 40)}`,
    `┃❍ Declared: ${codeSafe(declared, 60)}`,
    `┃❍ Author: ${safe(pkg?.author || 'Lord Eagle', 100)}`,
    `┃❍ License: ${codeSafe(pkg?.license || 'MIT', 40)}`,
    waVersion ? `┃❍ WA Web: ${codeSafe(waVersion, 80)}` : null,
    `┃❍ Node: ${codeSafe(process.version, 30)}`,
    gitUrl ? `┃❍ Source: ${codeSafe(gitUrl, 220)}` : null,
    '╰──────────⊷',
  ].filter(Boolean);
  return { handled: true, text: lines.join('\n') };
}

async function route(ctx, input) {
  const parsed = commandPrefix.parseCommand(input);
  const text = parsed.text.trim();
  if (!isCommand(input)) return { handled: false };
  if (commandPrefix.needsPrefix(parsed)) {
    return { handled: true, text: `This command needs the configured prefix. Try: \`${parsed.prefix}${text}\`` };
  }

  const match = text.match(/^(\S+)(?:\s+([\s\S]+))?$/);
  const command = (match?.[1] || '').toLowerCase();
  const raw = (match?.[2] || '').trim();

  if (command === 'currency') return currencyCommand(raw);
  if (command === 'country') return countryCommand(raw, 'country');
  if (command === 'callingcode') return countryCommand(raw, 'callingcode');
  if (command === 'population') return countryCommand(raw, 'population');
  if (command === 'gh' || command === 'github') return githubLookupCommand(command, raw);
  if (command === 'cryptoconvert') return cryptoConvertCommand(raw);
  if (command === 'cryptonews') return cryptoNewsCommand();
  if (command === 'baileysversion') return baileysVersionCommand();
  return { handled: false };
}

module.exports = {
  isCommand,
  route,
  menuCommands,
  publicGithubMenuCommands,
};
