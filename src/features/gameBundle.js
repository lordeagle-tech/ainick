'use strict';

module.exports = (runtime) => {
runtime.define("achievements", "achievements.js", function(module, exports, require, __filename, __dirname) {
// unlock(userId, key) call that other features fire when something noteworthy happens.
// Deliberately simple (no complex trigger DSL) — each feature module just calls unlock()
// at the moment its own condition becomes true.
const { Collection } = require('../db');

const store = new Collection('achievements', {}); // userId -> [achievementId]

const CATALOG = {
  first_pack: { name: 'Card Collector', emoji: '🃏', desc: 'Opened your first card pack.' },
  first_win: { name: 'First Blood', emoji: '⚔️', desc: 'Won your first card battle.' },
  battle_streak_5: { name: 'On a Roll', emoji: '🔥', desc: 'Won 5 card battles.' },
  level_10: { name: 'Regular', emoji: '⭐', desc: 'Reached level 10.' },
  level_25: { name: 'Veteran', emoji: '🌟', desc: 'Reached level 25.' },
  rich_5000: { name: 'High Roller', emoji: '💰', desc: `Held a wallet balance of 5,000+.` },
  banker: { name: 'Banker', emoji: '🏦', desc: 'Made your first bank deposit.' },
  married: { name: 'Tied the Knot', emoji: '💍', desc: 'Got married.' },
  legendary_pull: { name: 'Legendary!', emoji: '👑', desc: 'Pulled a legendary card from a pack.' },
  wordgrid_win: { name: 'Wordsmith', emoji: '🟩', desc: 'Solved a wordgrid puzzle.' },
};

function has(userId, key) {
  return store.get(userId, []).includes(key);
}

/** Idempotent — safe to call every time the condition is checked, only unlocks once. */
function unlock(userId, key) {
  if (!CATALOG[key]) return null; // unknown key, silently ignore
  if (has(userId, key)) return null; // already have it, no-op
  const owned = store.get(userId, []);
  owned.push(key);
  store.set(userId, owned);
  return { ...CATALOG[key], key };
}

function list(userId) {
  const owned = store.get(userId, []);
  return owned.map((key) => ({ ...CATALOG[key], key }));
}

function allDefinitions() {
  return Object.entries(CATALOG).map(([key, def]) => ({ ...def, key }));
}

module.exports = { unlock, has, list, allDefinitions };

});

runtime.define("economy", "economy.js", function(module, exports, require, __filename, __dirname) {
const { Collection } = require('../db');
const config = require('../config');
const { fmtCurrency, timeAgo } = require('../utils/helpers');
const achievements = require('./achievements');

const wallets = new Collection('economy_wallets', {});
const bank = new Collection('economy_bank', {});
const cooldowns = new Collection('economy_cooldowns', {});

const CUR = config.economy.currencyName;

function normalizeId(userId) {
  // Always store by phone digits only so LID / device / @s.whatsapp.net share one wallet
  const raw = String(userId || '');
  const digits = raw.replace(/\D/g, '');
  // Prefer full international-ish number; if LID-looking short noise, still use digits
  return digits || raw.split('@')[0].split(':')[0] || raw;
}

function getBalance(userId) {
  return wallets.get(normalizeId(userId), 0);
}

function addBalance(userId, amount) {
  const id = normalizeId(userId);
  const bal = wallets.update(id, (b) => (b || 0) + amount, 0);
  if (bal >= 5000) achievements.unlock(id, 'rich_5000');
  return bal;
}

function setBalance(userId, amount) {
  return wallets.set(normalizeId(userId), amount);
}

/** Wallet + bank = total wealth shown on profile/balance. */
function getTotalBalance(userId) {
  const id = normalizeId(userId);
  return getBalance(id) + getBankBalance(id);
}

function getFullAccount(userId) {
  const id = normalizeId(userId);
  return {
    id,
    wallet: getBalance(id),
    bank: getBankBalance(id),
    total: getBalance(id) + getBankBalance(id),
  };
}

function transfer(fromId, toId, amount) {
  if (amount <= 0) throw new Error('Amount must be positive.');
  const bal = getBalance(fromId);
  if (bal < amount) throw new Error(`Not enough ${CUR}. Balance: ${fmtCurrency(bal, CUR)}.`);
  addBalance(fromId, -amount);
  addBalance(toId, amount);
  return { from: getBalance(fromId), to: getBalance(toId) };
}

function _cooldownKey(userId, kind) {
  return `${userId}:${kind}`;
}

function claimDaily(userId) {
  const key = _cooldownKey(userId, 'daily');
  const last = cooldowns.get(key, 0);
  const cooldownMs = config.economy.dailyCooldownHours * 3600 * 1000;
  const remaining = last + cooldownMs - Date.now();
  if (remaining > 0) {
    return { ok: false, message: `You already claimed your daily. Try again in ${timeAgo(remaining)}.` };
  }
  cooldowns.set(key, Date.now());
  const amount = config.economy.dailyAmount;
  const bal = addBalance(userId, amount);
  return { ok: true, message: `You claimed your daily ${fmtCurrency(amount, CUR)}. New balance: ${fmtCurrency(bal, CUR)}.`, amount, balance: bal };
}

function work(userId) {
  const key = _cooldownKey(userId, 'work');
  const last = cooldowns.get(key, 0);
  const cooldownMs = config.economy.workCooldownMin * 60 * 1000;
  const remaining = last + cooldownMs - Date.now();
  if (remaining > 0) {
    return { ok: false, message: `You're tired. Rest for ${timeAgo(remaining)} before working again.` };
  }
  cooldowns.set(key, Date.now());
  const { workMin, workMax } = config.economy;
  const amount = Math.floor(Math.random() * (workMax - workMin + 1)) + workMin;
  const bal = addBalance(userId, amount);
  return { ok: true, message: `You worked and earned ${fmtCurrency(amount, CUR)}. New balance: ${fmtCurrency(bal, CUR)}.`, amount, balance: bal };
}

function leaderboard(limit = 10) {
  const all = wallets.all();
  return Object.entries(all)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([userId, balance]) => ({ userId, balance }));
}

function getBankBalance(userId) {
  return bank.get(userId, 0);
}

/** Move money wallet -> bank. Banked money is untouchable by economy_rob. */
function deposit(userId, amount) {
  amount = Math.floor(amount);
  if (amount <= 0) return { ok: false, error: 'Amount must be positive.' };
  const walletBal = getBalance(userId);
  if (walletBal < amount) return { ok: false, error: `Not enough in your wallet. You have ${fmtCurrency(walletBal, CUR)}.` };
  addBalance(userId, -amount);
  const newBank = bank.update(userId, (b) => (b || 0) + amount, 0);
  const unlocked = achievements.unlock(userId, 'banker');
  return { ok: true, deposited: amount, wallet: getBalance(userId), bank: newBank, achievement: unlocked };
}

/** Move money bank -> wallet (makes it robbable again, same trade-off as a real bank run). */
function withdraw(userId, amount) {
  amount = Math.floor(amount);
  if (amount <= 0) return { ok: false, error: 'Amount must be positive.' };
  const bankBal = getBankBalance(userId);
  if (bankBal < amount) return { ok: false, error: `Not enough in your bank. You have ${fmtCurrency(bankBal, CUR)}.` };
  bank.update(userId, (b) => (b || 0) - amount, 0);
  const newWallet = addBalance(userId, amount);
  return { ok: true, withdrawn: amount, wallet: newWallet, bank: getBankBalance(userId) };
}

/**
 * Rob another user's WALLET balance only — banked money (see deposit/withdraw) is always
 * safe. Success chance + a minimum victim balance so it can't be used to grief someone
 * sitting at 0, a shared cooldown so it can't be spammed, and a penalty on failure so it's
 * a real risk/reward mechanic rather than free money.
 */
function rob(fromId, toId) {
  if (fromId === toId) return { ok: false, message: "You can't rob yourself." };
  const key = _cooldownKey(fromId, 'rob');
  const last = cooldowns.get(key, 0);
  const cooldownMs = (config.economy.robCooldownMin || 30) * 60 * 1000;
  const remaining = last + cooldownMs - Date.now();
  if (remaining > 0) {
    return { ok: false, message: `Lay low — try robbing again in ${timeAgo(remaining)}.` };
  }
  const victimBal = getBalance(toId);
  const minTarget = config.economy.robMinVictimBalance ?? 50;
  if (victimBal < minTarget) {
    return { ok: false, message: `Not worth robbing — they only have ${fmtCurrency(victimBal, CUR)}.` };
  }
  cooldowns.set(key, Date.now());
  const successChance = config.economy.robSuccessChance ?? 0.45;
  const success = Math.random() < successChance;
  if (success) {
    const pct = config.economy.robMaxPercent ?? 0.25;
    const amount = Math.max(1, Math.floor(victimBal * pct * (0.5 + Math.random() * 0.5)));
    addBalance(toId, -amount);
    addBalance(fromId, amount);
    return { ok: true, success: true, amount, message: `You robbed ${fmtCurrency(amount, CUR)}! New balance: ${fmtCurrency(getBalance(fromId), CUR)}.` };
  } else {
    const finePct = config.economy.robFailFinePercent ?? 0.15;
    const robberBal = getBalance(fromId);
    const fine = Math.max(1, Math.floor(robberBal * finePct));
    addBalance(fromId, -fine);
    return { ok: true, success: false, fine, message: `Caught! You paid a ${fmtCurrency(fine, CUR)} fine. New balance: ${fmtCurrency(getBalance(fromId), CUR)}.` };
  }
}

module.exports = { normalizeId, getTotalBalance, getFullAccount,  getBalance, addBalance, setBalance, transfer, claimDaily, work, rob, leaderboard, getBankBalance, deposit, withdraw, CUR };

});

runtime.define("funExtras", "funExtras.js", function(module, exports, require, __filename, __dirname) {
const axios = require('axios');
const { Collection } = require('../db');
const economy = require('./economy');
const { numFromJid } = require('../utils/helpers');

const vibes = new Collection('user_vibes', {});

const QUOTES = [
  'The only way to do great work is to love what you do. — Steve Jobs',
  'It always seems impossible until it is done. — Nelson Mandela',
  'Simplicity is the ultimate sophistication. — Leonardo da Vinci',
  'Stay hungry, stay foolish. — Steve Jobs',
  'Be yourself; everyone else is already taken. — Oscar Wilde',
  'In the middle of difficulty lies opportunity. — Einstein',
];

const FACTS = [
  'Honey never spoils — edible honey was found in ancient Egyptian tombs.',
  'Octopuses have three hearts.',
  'Bananas are berries; strawberries are not.',
  'A day on Venus is longer than a year on Venus.',
  'Your brain uses about 20% of your body\'s energy.',
  'Sharks existed before trees.',
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function quote() {
  return `💬 ${pick(QUOTES)}`;
}

function fact() {
  return `🧠 ${pick(FACTS)}`;
}

async function translate(text, to = 'en') {
  const q = String(text || '').trim();
  if (!q) return { ok: false, error: 'What should I translate?' };
  // normalize common language names → codes
  const LANG = {
    english: 'en', en: 'en', french: 'fr', fr: 'fr', spanish: 'es', es: 'es',
    portuguese: 'pt', pt: 'pt', arabic: 'ar', ar: 'ar', hausa: 'ha', ha: 'ha',
    yoruba: 'yo', yo: 'yo', igbo: 'ig', ig: 'ig', german: 'de', de: 'de',
    italian: 'it', it: 'it', chinese: 'zh', zh: 'zh', hindi: 'hi', hi: 'hi',
    pidgin: 'en', // best-effort
  };
  let target = String(to || 'en').toLowerCase().trim();
  target = LANG[target] || target.slice(0, 8);

  // 1) MyMemory
  try {
    const { data } = await axios.get('https://api.mymemory.translated.net/get', {
      params: { q: q.slice(0, 500), langpair: `autodetect|${target}` },
      timeout: 20000,
    });
    const out = data?.responseData?.translatedText;
    if (out && String(out).toLowerCase() !== q.toLowerCase()) {
      return { ok: true, text: out, to: target, source: 'mymemory' };
    }
    if (out) return { ok: true, text: out, to: target, source: 'mymemory' };
  } catch {}

  // 2) LibreTranslate public instance
  try {
    const { data } = await axios.post(
      'https://libretranslate.com/translate',
      { q: q.slice(0, 1000), source: 'auto', target, format: 'text' },
      { timeout: 20000, headers: { 'Content-Type': 'application/json' } }
    );
    if (data?.translatedText) {
      return { ok: true, text: data.translatedText, to: target, source: 'libre' };
    }
  } catch {}

  return { ok: false, error: 'Translation services timed out. Try again in a moment.' };
}

function setVibe(userJid, vibe) {
  const v = String(vibe || '').trim().slice(0, 80);
  vibes.set(numFromJid(userJid), { vibe: v, at: Date.now() });
  return v;
}

function getVibe(userJid) {
  return vibes.get(numFromJid(userJid), null);
}

function flip() {
  return Math.random() < 0.5 ? '🪙 Heads' : '🪙 Tails';
}

function roll(sides = 6) {
  const n = Math.max(2, Math.min(100, Number(sides) || 6));
  return `🎲 ${1 + Math.floor(Math.random() * n)} (d${n})`;
}

function shipPercent(a, b) {
  const s = String(numFromJid(a)) + String(numFromJid(b));
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 101;
}

async function weather(city) {
  const q = String(city || '').trim();
  if (!q) return { ok: false, error: 'Which city?' };
  try {
    const { data } = await axios.get('https://wttr.in/' + encodeURIComponent(q), {
      params: { format: 'j1' },
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const cur = data?.current_condition?.[0];
    const area = data?.nearest_area?.[0]?.areaName?.[0]?.value || q;
    if (!cur) throw new Error('no data');
    return {
      ok: true,
      text: `🌤️ *${area}*\n${cur.weatherDesc?.[0]?.value || ''} · ${cur.temp_C}°C (feels ${cur.FeelsLikeC}°C)\nHumidity ${cur.humidity}% · Wind ${cur.windspeedKmph} km/h`,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function tipJar(userJid, amount = 10) {
  const a = Math.max(1, Math.min(500, Number(amount) || 10));
  const bal = economy.getBalance(numFromJid(userJid));
  if (bal < a) return { ok: false, error: `Not enough coins (have ${bal}).` };
  economy.addBalance(numFromJid(userJid), -a);
  return { ok: true, text: `🙏 Tipped ${a} coins into the void. New balance: ${economy.getBalance(numFromJid(userJid))}.` };
}

module.exports = {
  quote, fact, translate, setVibe, getVibe, flip, roll, shipPercent, weather, tipJar,
};

});

runtime.define("funFeed", "funFeed.js", function(module, exports, require, __filename, __dirname) {
const axios = require('axios');
const logger = require('../logger');
const canvas = require('./canvas');

async function getJson(url, opts = {}) {
  const { data } = await axios.get(url, {
    timeout: 18000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      Accept: 'application/json',
      ...(opts.headers || {}),
    },
    validateStatus: (s) => s < 500,
    ...opts,
  });
  return data;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

const TWEETS_FUNNY = [
  "Me: I'll start being productive tomorrow.\nTomorrow:",
  "Nobody:\nMy brain at 3am: remember that embarrassing thing from 2014?",
  "Group project be like: 1 person doing everything, 4 people in the chat saying 'lmk if you need help'",
  "My sleep schedule is held together by vibes and spite.",
  "Opened the fridge for the 4th time hoping different food appeared. It did not.",
  "When someone says 'we need to talk' and your whole life flashes before your eyes.",
  "Me explaining my career plans: 🧠✨\nMe actually job hunting: 🫠",
  "WiFi went out for 5 minutes and I considered becoming a farmer.",
  "Saying 'one more episode' at 2am is a legally binding contract with regret.",
  "My bank account and my shopping cart are in a toxic relationship.",
  "Tried to adult today. Adulting filed a restraining order.",
  "Notification: 'You have been inactive for a while'\nMe: that's the goal.",
  "Me: I don't need therapy\nAlso me: narrating my life in third person for entertainment",
  "The way I speed-walk away from my problems should qualify as cardio.",
];

const TWEETS_BLACK = [
  "The way some of y'all move... the ancestors are tired.",
  "Ain't no way you really said that with your whole chest.",
  "I'm not arguing, I'm explaining why I'm right. There's a difference.",
  "If you quiet, you plotting. If you loud, you still plotting. We see you.",
  "My mom didn't raise no fool... she raised a tired professional who needs a nap.",
  "Some of y'all need Jesus, therapy, AND a hobby.",
  "The disrespect was Olympic level. Gold medal in mess.",
  "I laughed so I wouldn't cry. Emotional range is elite.",
  "Why is the AC always competing with my will to live in this building?",
  "Group chat energy at 11pm vs responsibilities at 7am — two different people.",
  "You really thought I was playing? I keep receipts.",
  "The way life be testing me like I signed up for a challenge.",
  "Be so for real right now.",
  "I'm screaming. This cannot be life.",
];

const DEBATES = [
  "Pineapple belongs on pizza.",
  "Remote work is better than office work for almost everyone.",
  "Social media has done more harm than good.",
  "College is overrated for most careers.",
  "Cats are better pets than dogs.",
  "Morning people secretly look down on night owls.",
  "Emoji in professional emails should be banned.",
  "AI art is real art.",
  "Texting is better than phone calls.",
  "Cereal is a valid dinner.",
  "Most meetings could just be an email.",
  "The best season is rainy season.",
  "Unpopular opinion: silence is better than small talk.",
  "Hot take: the early bird gets the worm, but the second mouse gets the cheese.",
];

async function randomMeme() {
  try {
    const data = await getJson('https://api.popcat.xyz/meme');
    const image = data?.content?.imageHigh || data?.content?.image || data?.url || data?.image;
    if (image) {
      return {
        ok: true,
        title: data.title || 'Meme',
        image,
        post: data.link || image,
        sub: data.subreddit || 'meme',
        author: data.author || '',
      };
    }
  } catch (e) {
    logger.warn({ err: e.message }, 'popcat meme failed');
  }
  try {
    const data = await getJson('https://api.imgflip.com/get_memes');
    const memes = data?.data?.memes || [];
    if (memes.length) {
      const m = pick(memes);
      return { ok: true, title: m.name, image: m.url, post: m.url, sub: 'imgflip', author: '' };
    }
  } catch (e) {
    logger.warn({ err: e.message }, 'imgflip failed');
  }
  return { ok: false, error: 'Meme sources busy — try again.' };
}

async function liveJokeLines() {
  const live = [];
  try {
    const j = await getJson('https://v2.jokeapi.dev/joke/Pun,Miscellaneous?type=single&amount=3');
    const jokes = Array.isArray(j.jokes) ? j.jokes : j.joke ? [j] : [];
    for (const x of jokes) if (x?.joke) live.push(x.joke);
  } catch {}
  try {
    const j = await getJson('https://api.popcat.xyz/joke');
    if (j?.joke) live.push(j.joke);
  } catch {}
  try {
    const j = await getJson('https://official-joke-api.appspot.com/random_joke');
    if (j?.setup) live.push(`${j.setup}\n${j.punchline}`);
  } catch {}
  return live;
}

async function renderTweet({ text, handle, name, theme }) {
  try {
    const buf = await canvas.tweetCard({
      text,
      handle: handle || 'broken',
      name: name || 'Broken',
      likes: Math.floor(Math.random() * 12000) + 200,
      theme: theme || 'dark',
    });
    return buf;
  } catch (e) {
    logger.warn({ err: e.message }, 'tweetCard render failed');
    return null;
  }
}

/**
 * Funny / black-twitter style posts rendered as tweet images.
 */
async function funnyPosts(sub = 'funny', limit = 1) {
  const key = String(sub).toLowerCase();
  const pool =
    key === 'blacktwitter' || key === 'black' ? TWEETS_BLACK
    : key === 'debate' ? DEBATES
    : TWEETS_FUNNY;

  const live = await liveJokeLines();
  const combined = [...live, ...pool];
  const text = pick(combined);

  const isBlack = key === 'blacktwitter' || key === 'black';
  const handle = isBlack ? 'timeline' : key === 'debate' ? 'debateclub' : 'for_you';
  const name = isBlack ? 'The Timeline' : key === 'debate' ? 'Debate Club' : 'For You';
  const theme = isBlack ? 'dark' : 'dark';

  const image = await renderTweet({ text, handle, name, theme });
  const label =
    isBlack ? 'BlackTwitter'
    : key === 'tweets' ? 'FunnyTweet'
    : key === 'tiktok' ? 'Comedy'
    : key === 'debate' ? 'Debate'
    : 'Funny';

  return {
    ok: true,
    sub: label,
    posts: [{
      title: text,
      author: handle,
      url: '',
      ups: Math.floor(Math.random() * 9000) + 100,
      image, // PNG buffer (tweet card) or null
      selftext: '',
      isTweetCard: !!image,
    }],
  };
}

async function debateTopic() {
  let topic = pick(DEBATES);
  try {
    const live = await liveJokeLines();
    // Prefer short opinion-like lines for debate; otherwise curated
    const short = live.filter((x) => x.length < 160 && !x.includes('?'));
    if (short.length) topic = pick(short);
  } catch {}

  const promptText = `Hot take:\n${topic}\n\nAgree or Disagree?`;
  const image = await renderTweet({
    text: promptText,
    handle: 'debateclub',
    name: 'Debate Club',
    theme: 'dark',
  });

  return {
    ok: true,
    topic,
    body: '',
    url: '',
    image, // tweet-style PNG
    isTweetCard: !!image,
    prompt: `🗣 *Debate this:*\n\n"${topic}"\n\nReply with your take — Agree or Disagree?`,
  };
}

async function comedyBit() {
  try {
    const joke = await getJson('https://official-joke-api.appspot.com/random_joke');
    if (joke?.setup) {
      const text = `${joke.setup}\n\n${joke.punchline}`;
      const image = await renderTweet({ text, handle: 'comedy', name: 'Comedy Night' });
      return { ok: true, type: 'joke', text: `😂 *${joke.setup}*\n\n_${joke.punchline}_`, image, isTweetCard: !!image };
    }
  } catch (e) {
    logger.warn({ err: e.message }, 'official joke failed');
  }
  try {
    const j = await getJson('https://v2.jokeapi.dev/joke/Any?type=twopart');
    if (j?.setup) {
      const text = `${j.setup}\n\n${j.delivery}`;
      const image = await renderTweet({ text, handle: 'comedy', name: 'Comedy Night' });
      return { ok: true, type: 'joke', text: `😂 *${j.setup}*\n\n_${j.delivery}_`, image, isTweetCard: !!image };
    }
    if (j?.joke) {
      const image = await renderTweet({ text: j.joke, handle: 'comedy', name: 'Comedy Night' });
      return { ok: true, type: 'joke', text: `😂 ${j.joke}`, image, isTweetCard: !!image };
    }
  } catch {}
  const text = pick(TWEETS_FUNNY);
  const image = await renderTweet({ text, handle: 'comedy', name: 'Comedy Night' });
  return { ok: true, type: 'tweet', text: `😂 ${text}`, image, isTweetCard: !!image };
}

async function tiktokComedy() {
  try {
    const m = await randomMeme();
    if (m.ok && m.image) {
      return {
        ok: true,
        title: m.title,
        url: m.post || '',
        image: m.image,
        caption: `🎬 *Comedy vibes*\n${m.title}`,
      };
    }
  } catch {}
  const text = pick(TWEETS_FUNNY);
  const image = await renderTweet({ text, handle: 'foryou', name: 'For You' });
  return {
    ok: true,
    title: text,
    url: '',
    image,
    isTweetCard: !!image,
    caption: `🎬 *Comedy energy*\n${text}`,
  };
}

module.exports = {
  randomMeme,
  funnyPosts,
  debateTopic,
  comedyBit,
  tiktokComedy,
  renderTweet,
};

});

runtime.define("games", "games.js", function(module, exports, require, __filename, __dirname) {
// game logic (the LLM can route here via a tool, but games run on plain commands
// so they're instant and can't be talked out of by the model).
//
// Games:
//   trivia       — multiple-choice quiz questions (correct = +eco coins)
//   scramble     — guess the anagrammed word
//   guess        — guess the number 1..N (highest-first elimination)
//   riddle       — answer a riddle
//   blackjack    — casino-style 21 against the bot, betting economy coins
//   coinflip     — bet coins, call heads/tails
//
// All hosted per-chat. Starting a game in one group doesn't affect another.
const { Collection } = require('../db');
const economy = require('./economy');
const { numFromJid } = require('../utils/helpers');
const achievements = require('./achievements');

const store = new Collection('games', {}); // chatId -> { type, state, ... }
const LEADER = new Collection('game_scores', {}); // num -> wins

// ---------- question banks ----------
const TRIVIA = [
  { q: 'What is the capital of France?', a: 'Paris', opts: ['Paris', 'London', 'Berlin', 'Madrid'] },
  { q: 'How many continents are there?', a: '7', opts: ['5', '6', '7', '8'] },
  { q: 'What planet is known as the Red Planet?', a: 'Mars', opts: ['Venus', 'Mars', 'Jupiter', 'Mercury'] },
  { q: 'What is 9 x 8?', a: '72', opts: ['64', '72', '81', '63'] },
  { q: 'Which animal is the largest mammal?', a: 'Blue whale', opts: ['Elephant', 'Blue whale', 'Giraffe', 'Orca'] },
  { q: 'What gas do plants absorb from the air?', a: 'Carbon dioxide', opts: ['Oxygen', 'Carbon dioxide', 'Nitrogen', 'Hydrogen'] },
  { q: 'How many legs does a spider have?', a: '8', opts: ['6', '8', '10', '12'] },
  { q: 'What is the largest ocean?', a: 'Pacific', opts: ['Atlantic', 'Indian', 'Pacific', 'Arctic'] },
  { q: 'Which country is famous for the Great Wall?', a: 'China', opts: ['Japan', 'India', 'China', 'Korea'] },
  { q: 'What is H2O commonly known as?', a: 'Water', opts: ['Salt', 'Water', 'Oxygen', 'Milk'] },
  { q: 'How many sides does a hexagon have?', a: '6', opts: ['5', '6', '7', '8'] },
  { q: 'What is the smallest prime number?', a: '2', opts: ['0', '1', '2', '3'] },
  { q: 'What is the capital of Japan?', a: 'Tokyo', opts: ['Osaka', 'Tokyo', 'Kyoto', 'Nagoya'] },
  { q: 'What is the chemical symbol for gold?', a: 'Au', opts: ['Ag', 'Au', 'Fe', 'Go'] },
  { q: 'Who painted the Mona Lisa?', a: 'Leonardo da Vinci', opts: ['Picasso', 'Van Gogh', 'Leonardo da Vinci', 'Michelangelo'] },
  { q: 'What is the fastest land animal?', a: 'Cheetah', opts: ['Lion', 'Cheetah', 'Horse', 'Leopard'] },
  { q: 'How many days are in a leap year?', a: '366', opts: ['365', '366', '364', '360'] },
  { q: 'What language is spoken in Brazil?', a: 'Portuguese', opts: ['Spanish', 'Portuguese', 'French', 'English'] },
  { q: 'What is the tallest mountain in the world?', a: 'Mount Everest', opts: ['K2', 'Mount Everest', 'Kilimanjaro', 'Denali'] },
  { q: 'What is the square root of 144?', a: '12', opts: ['10', '11', '12', '14'] },
  { q: 'What do bees make?', a: 'Honey', opts: ['Milk', 'Honey', 'Silk', 'Wax only'] },
  { q: 'How many colors are in a rainbow?', a: '7', opts: ['5', '6', '7', '8'] },
  { q: 'Which organ pumps blood?', a: 'Heart', opts: ['Liver', 'Lungs', 'Heart', 'Kidney'] },
  { q: 'What is 15 + 27?', a: '42', opts: ['32', '41', '42', '52'] },
  { q: 'Which bird cannot fly?', a: 'Penguin', opts: ['Eagle', 'Penguin', 'Sparrow', 'Hawk'] },
  { q: "What is the main gas in Earth's atmosphere?", a: 'Nitrogen', opts: ['Oxygen', 'Nitrogen', 'Carbon dioxide', 'Hydrogen'] },
  { q: 'How many hours are in two days?', a: '48', opts: ['24', '36', '48', '60'] },
  { q: 'What color do you get mixing red and blue?', a: 'Purple', opts: ['Green', 'Orange', 'Purple', 'Brown'] },
  { q: 'Which country gifted the Statue of Liberty to the USA?', a: 'France', opts: ['England', 'France', 'Spain', 'Italy'] },
  { q: 'How many players are on a football (soccer) team on the field?', a: '11', opts: ['9', '10', '11', '12'] },
];

const RIDDLES = [
  { r: "I speak without a mouth and hear without ears. What am I?", a: 'echo' },
  { r: "The more you take, the more you leave behind. What am I?", a: 'footsteps' },
  { r: "What has keys but can't open locks?", a: 'piano' },
  { r: "What gets wetter the more it dries?", a: 'towel' },
  { r: "What has a head, a tail, but no body?", a: 'coin' },
  { r: "What has hands but can't clap?", a: 'clock' },
  { r: "What goes up but never comes down?", a: 'age' },
  { r: "What has one eye but can't see?", a: 'needle' },
  { r: "What has legs but doesn't walk?", a: 'table' },
  { r: "I have cities, but no houses; mountains, but no trees; water, but no fish. What am I?", a: 'map' },
];

const WORDS = ['orange', 'banana', 'elephant', 'guitar', 'umbrella', 'diamond', 'mountain', 'airplane', 'sunflower', 'keyboard', 'chocolate', 'adventure', 'calendar', 'elephant', 'notebook', 'symphony'];

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- helpers ----------
function current(chatId) {
  const game = store.get(chatId, null);
  // Migration: remove any legacy word-chain state left by older bot versions.
  // WCG now lives exclusively in socialGames.js.
  if (game?.type === 'chain') {
    store.delete(chatId);
    return null;
  }
  return game;
}
function setGame(chatId, game) {
  store.set(chatId, game);
}
function end(chatId) {
  store.delete(chatId);
}
function addWin(userJid) {
  const key = economy.normalizeId(numFromJid(userJid));
  // Repair legacy score corruption such as "[object Object]1" and object-shaped rows.
  const raw = LEADER.get(key, 0);
  const previous = (raw && typeof raw === 'object') ? Number(raw.wins) : Number(raw);
  const wins = Number.isFinite(previous) && previous >= 0 ? Math.floor(previous) + 1 : 1;
  LEADER.set(key, wins);
  try { economy.recordGame(key, 'win'); } catch {}
  return wins;
}
function awardWin(userJid, amount = 100) {
  economy.addBalance(numFromJid(userJid), amount, 'game_win');
  return addWin(userJid);
}
function leaderboard() {
  return Object.entries(LEADER.all())
    .map(([userId, raw]) => {
      const wins = (raw && typeof raw === 'object') ? Number(raw.wins) : Number(raw);
      return [userId, Number.isFinite(wins) && wins >= 0 ? Math.floor(wins) : 0];
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
}

// ---------- game logic ----------
// Per-chat trivia history so questions do not repeat until the bank is exhausted
const triviaHistory = new Map(); // chatId -> Set of question strings

function startTrivia(chatId, senderJid) {
  let used = triviaHistory.get(chatId);
  if (!used) { used = new Set(); triviaHistory.set(chatId, used); }
  let pool = TRIVIA.filter((q) => !used.has(q.q));
  if (!pool.length) {
    used.clear();
    pool = TRIVIA.slice();
  }
  const q = pool[Math.floor(Math.random() * pool.length)];
  used.add(q.q);
  const opts = shuffle(q.opts);
  const letters = ['A', 'B', 'C', 'D'];
  const lines = opts.map((o, i) => `*${letters[i]}* ${o}`).join('\n');
  setGame(chatId, { type: 'trivia', q, opts, answer: q.a, host: numFromJid(senderJid), started: Date.now() });
  return {
    text: `*🧠 Trivia!*\n${q.q}\n\n${lines}\n\nReply with the letter (A/B/C/D) or the answer. 30s on the clock!`,
    ttl: 30000,
  };
}

const SCRAMBLE_WORDS = [
  'orange', 'banana', 'elephant', 'guitar', 'umbrella', 'diamond', 'mountain', 'airplane',
  'sunflower', 'keyboard', 'chocolate', 'adventure', 'calendar', 'notebook', 'symphony',
  'pyramid', 'volcano', 'penguin', 'rainbow', 'treasure', 'library', 'hospital', 'sandwich',
  'computer', 'football', 'birthday', 'dinosaur', 'butterfly', 'telescope', 'backpack',
];

function startScramble(chatId, senderJid) {
  const pool = SCRAMBLE_WORDS.length ? SCRAMBLE_WORDS : WORDS;
  const word = String(pool[Math.floor(Math.random() * pool.length)]).toLowerCase();
  let scrambled = shuffle(word.split('')).join('');
  for (let i = 0; i < 8 && scrambled === word; i++) scrambled = shuffle(word.split('')).join('');
  setGame(chatId, { type: 'scramble', answer: word, scrambled, host: numFromJid(senderJid), started: Date.now() });
  return {
    text:
      `🔤 *Word Scramble!*\n` +
      `Unscramble: *${scrambled.toUpperCase()}*\n\n` +
      `First correct answer wins *100* coins.\n⏱️ 45 seconds`,
    ttl: 45000,
  };
}

function startGuess(chatId, senderJid) {
  const max = 100;
  const target = Math.floor(Math.random() * max) + 1;
  setGame(chatId, { type: 'guess', target, max, host: numFromJid(senderJid), started: Date.now(), hints: 0 });
  return {
    text: `*🎯 Guess the Number!*\nI'm thinking of a number 1-${max}. First to guess it wins 150 coins. 60s!`,
    ttl: 60000,
  };
}

function startRiddle(chatId, senderJid) {
  const r = RIDDLES[Math.floor(Math.random() * RIDDLES.length)];
  setGame(chatId, { type: 'riddle', answer: r.a, host: numFromJid(senderJid), started: Date.now() });
  return {
    text: `*🤔 Riddle!*\n${r.r}\n\nFirst to answer correctly wins 120 coins. 45s!`,
    ttl: 45000,
  };
}

function deck() {
  const vals = [2,3,4,5,6,7,8,9,10,10,10,10,11];
  return vals[Math.floor(Math.random() * vals.length)];
}
function sum(h) {
  let s = h.reduce((a,b)=>a+b,0);
  let aces = h.filter(x=>x===11).length;
  while (s>21 && aces) { s -= 10; aces--; }
  return s;
}
function startBlackjack(chatId, senderJid, bet) {
  const player = [deck(), deck()];
  const dealer = [deck(), deck()];
  setGame(chatId, { type: 'blackjack', player, dealer, bet, host: numFromJid(senderJid), started: Date.now() });
  return {
    text: `*🃏 Blackjack!* Bet: ${bet} ${economy.CUR}\n\nYou: ${player.join(' + ')} = ${sum(player)}\nDealer shows: ${dealer[0]}\n\n*hit* or *stand*?`,
  };
}

function startCoinflip(chatId, senderJid, bet) {
  setGame(chatId, { type: 'coinflip', bet, host: numFromJid(senderJid), started: Date.now() });
  return {
    text: `*🪙 Coinflip!* Bet: ${bet} ${economy.CUR}\nCall it: *heads* or *tails*?`,
  };
}

// ---------- answer evaluation ----------
function resolveAnswer(chatId, userJid, text) {
  const game = current(chatId);
  if (!game) return null;
  const lower = text.trim().toLowerCase();
  const ansLower = String(game.answer).toLowerCase();

  let correct = false;
  const soft = (a, b) => {
    const na = String(a||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
    const nb = String(b||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
    if (!na || !nb) return false;
    if (na === nb || na.includes(nb) || nb.includes(na)) return true;
    // simple edit distance ≤ 2 for short answers
    const m = Array.from({length: nb.length+1}, (_,i)=>i);
    for (let i=0;i<na.length;i++){ let prev=i+1; for(let j=0;j<nb.length;j++){ const cur=na[i]===nb[j]?m[j]:Math.min(m[j],m[j+1],prev)+1; m[j]=prev; prev=cur;} m[nb.length]=prev; }
    return m[nb.length] <= Math.min(2, Math.max(1, Math.floor(Math.min(na.length, nb.length)/5)));
  };
  if (game.type === 'trivia') {
    const letters = ['a','b','c','d'];
    const idx = letters.indexOf(lower);
    correct = idx !== -1 ? soft(String(game.opts[idx]), ansLower) : soft(lower, ansLower);
  } else if (game.type === 'scramble' || game.type === 'riddle') {
    correct = soft(lower, ansLower);
  } else {
    return null; // guess/blackjack/coinflip handled separately
  }

  if (!correct) return { correct: false };

  // win!
  const prize = game.type === 'trivia' ? 100 : game.type === 'scramble' ? 100 : 120;
  economy.addBalance(numFromJid(userJid), prize, 'game_win');
  const wins = addWin(userJid);
  end(chatId);
  return { correct: true, prize, wins };
}

function resolveGuess(chatId, userJid, text) {
  const game = current(chatId);
  if (!game || game.type !== 'guess') return null;
  const n = parseInt(text, 10);
  if (isNaN(n)) return null;
  if (n < game.target) { game.hints++; setGame(chatId, game); return { tooLow: true }; }
  if (n > game.target) { game.hints++; setGame(chatId, game); return { tooHigh: true }; }
  const prize = 150;
  economy.addBalance(numFromJid(userJid), prize, 'game_win');
  const wins = addWin(userJid);
  end(chatId);
  return { correct: true, prize, wins, target: game.target };
}

function resolveBlackjack(chatId, userJid, action) {
  const game = current(chatId);
  if (!game || game.type !== 'blackjack') return null;
  const bal = economy.getBalance(numFromJid(userJid));
  if (bal < game.bet) return { noFunds: true };

  if (action === 'hit') {
    game.player.push(deck());
    if (sum(game.player) > 21) {
      economy.addBalance(numFromJid(userJid), -game.bet);
      end(chatId);
      return { bust: true, hand: sum(game.player) };
    }
    setGame(chatId, game);
    return { hit: true, hand: sum(game.player) };
  }

  if (action === 'stand') {
    // dealer plays
    let d = game.dealer.slice();
    while (sum(d) < 17) d.push(deck());
    const p = sum(game.player);
    const de = sum(d);
    let result;
    if (de > 21 || p > de) { economy.addBalance(numFromJid(userJid), game.bet); result = 'win'; }
    else if (p === de) { result = 'push'; }
    else { economy.addBalance(numFromJid(userJid), -game.bet); result = 'lose'; }
    end(chatId);
    return { stand: true, player: p, dealer: de, result };
  }
  return null;
}

function resolveCoinflip(chatId, userJid, call) {
  const game = current(chatId);
  if (!game || game.type !== 'coinflip') return null;
  const bal = economy.getBalance(numFromJid(userJid));
  if (bal < game.bet) return { noFunds: true };
  const flip = Math.random() < 0.5 ? 'heads' : 'tails';
  const won = call === flip;
  economy.addBalance(numFromJid(userJid), won ? game.bet : -game.bet);
  if (won) awardWin(userJid, 100);
  end(chatId);
  return { flip, won, bet: game.bet };
}

// ---------- tic-tac-toe (vs bot) ----------
function startTtt(chatId, senderJid) {
  setGame(chatId, { type: 'ttt', board: Array(9).fill(null), turn: 'X', host: numFromJid(senderJid), started: Date.now() });
  return { text: '*⭕ Tic-Tac-Toe!*\nYou are X. Reply with a cell number 1-9:\n\n```\n1 2 3\n4 5 6\n7 8 9\n```' };
}
function tttBoardStr(board) {
  const s = board.map((c) => c || '·');
  return `${s[0]} ${s[1]} ${s[2]}\n${s[3]} ${s[4]} ${s[5]}\n${s[6]} ${s[7]} ${s[8]}`;
}
function tttWinner(b) {
  const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  for (const [a,c,d] of lines) if (b[a] && b[a] === b[c] && b[a] === b[d]) return b[a];
  return b.every(Boolean) ? 'draw' : null;
}
function resolveTtt(chatId, userJid, cell) {
  const game = current(chatId);
  if (!game || game.type !== 'ttt') return null;
  const i = cell - 1;
  if (i < 0 || i > 8 || game.board[i]) return { invalid: true, text: '❌ That cell is taken or invalid. Pick 1-9:' };
  game.board[i] = 'X';
  let winner = tttWinner(game.board);
  if (winner) { const res = { win: winner === 'X', draw: winner === 'draw', board: tttBoardStr(game.board) }; end(chatId); if (res.win) awardWin(userJid, 100); return res; }
  // bot move (random open cell)
  const open = game.board.map((v, idx) => v ? null : idx).filter((v) => v !== null);
  if (open.length) { game.board[open[Math.floor(Math.random() * open.length)]] = 'O'; }
  winner = tttWinner(game.board);
  if (winner) { const res = { win: false, draw: winner === 'draw', board: tttBoardStr(game.board) }; end(chatId); return res; }
  setGame(chatId, game);
  return { turn: true, board: tttBoardStr(game.board) };
}

// ---------- hangman ----------
const HANG_WORDS = ['elephant', 'keyboard', 'mountain', 'chocolate', 'adventure', 'umbrella', 'diamond', 'symphony', 'calendar', 'notebook'];
function startHangman(chatId, senderJid) {
  const word = HANG_WORDS[Math.floor(Math.random() * HANG_WORDS.length)];
  setGame(chatId, { type: 'hangman', word, guessed: [], wrong: 0, host: numFromJid(senderJid), started: Date.now() });
  return { text: `*🎯 Hangman!*\nWord: ${word.replace(/./g, '_ ').trim()}\nGuess a letter!` };
}
function resolveHangman(chatId, userJid, letter) {
  const game = current(chatId);
  if (!game || game.type !== 'hangman') return null;
  const l = letter.toLowerCase();
  if (game.guessed.includes(l)) return { invalid: true, text: '❌ Already guessed that letter.' };
  game.guessed.push(l);
  if (!game.word.includes(l)) game.wrong++;
  const display = game.word.split('').map((c) => game.guessed.includes(c) ? c : '_').join(' ');
  if (game.wrong >= 6) { const w = game.word; end(chatId); return { lose: true, word: w, display }; }
  if (!game.word.split('').some((c) => !game.guessed.includes(c))) { end(chatId); awardWin(userJid, 100); return { win: true, display }; }
  setGame(chatId, game);
  return { turn: true, display, wrong: game.wrong, guessed: game.guessed.join(' ') };
}

// ---------- slot machine (bet coins) ----------
const SLOT_SYMBOLS = ['🍒', '🍋', '🍇', '💎', '7️⃣', '⭐'];
function startSlot(chatId, senderJid, bet) {
  setGame(chatId, { type: 'slot', bet, host: numFromJid(senderJid), started: Date.now() });
  return { text: `*🎰 Slot Machine!*\nBet: ${bet} ${economy.CUR}\nReply *spin* to play!` };
}
function resolveSlot(chatId, userJid, action) {
  const game = current(chatId);
  if (!game || game.type !== 'slot') return null;
  const bal = economy.getBalance(numFromJid(userJid));
  if (bal < game.bet) return { noFunds: true };
  const r1 = SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)];
  const r2 = SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)];
  const r3 = SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)];
  const line = `${r1} ${r2} ${r3}`;
  let result, payout = 0;
  if (r1 === r2 && r2 === r3) { result = 'jackpot'; payout = game.bet * 5; }
  else if (r1 === r2 || r2 === r3 || r1 === r3) { result = 'pair'; payout = game.bet * 1.5; }
  else result = 'loss';
  if (payout > 0) economy.addBalance(numFromJid(userJid), payout);
  else economy.addBalance(numFromJid(userJid), -game.bet);
  end(chatId);
  return { line, result, payout: Math.round(payout), bet: game.bet };
}

// ---------- multiplayer quiz ----------
const QUIZ = [
  { q: 'What is the capital of Australia?', a: 'Canberra', opts: ['Sydney', 'Canberra', 'Melbourne', 'Perth'] },
  { q: 'Which element has the symbol Au?', a: 'Gold', opts: ['Silver', 'Gold', 'Copper', 'Aluminum'] },
  { q: 'How many players are on a football (soccer) team?', a: '11', opts: ['9', '10', '11', '12'] },
  { q: 'What is the largest planet?', a: 'Jupiter', opts: ['Earth', 'Saturn', 'Jupiter', 'Neptune'] },
  { q: 'Who painted the Mona Lisa?', a: 'Leonardo da Vinci', opts: ['Picasso', 'Van Gogh', 'Leonardo da Vinci', 'Rembrandt'] },
  { q: 'What is the chemical formula for water?', a: 'H2O', opts: ['CO2', 'H2O', 'O2', 'NaCl'] },
  { q: 'Which country has the most people?', a: 'India', opts: ['China', 'India', 'USA', 'Indonesia'] },
  { q: 'What is the fastest land animal?', a: 'Cheetah', opts: ['Lion', 'Horse', 'Cheetah', 'Leopard'] },
  { q: 'How many bones are in the adult human body?', a: '206', opts: ['196', '206', '216', '226'] },
  { q: 'What language is spoken in Brazil?', a: 'Portuguese', opts: ['Spanish', 'Portuguese', 'French', 'English'] },
];
function startQuiz(chatId, senderJid) {
  const qi = Math.floor(Math.random() * QUIZ.length);
  const q = QUIZ[qi];
  const opts = shuffle(q.opts);
  setGame(chatId, { type: 'quiz', q, opts, answer: q.a, scores: {}, host: numFromJid(senderJid), started: Date.now() });
  return { text: `*🏆 Multiplayer Quiz!*\n${q.q}\n\n${opts.map((o, i) => `${['A','B','C','D'][i]}) ${o}`).join('\n')}\n\nFirst to answer correctly wins 150 coins!` };
}
function resolveQuiz(chatId, userJid, answer) {
  const game = current(chatId);
  if (!game || game.type !== 'quiz') return null;
  const letters = ['a','b','c','d'];
  const idx = letters.indexOf(answer.toLowerCase());
  const correct = idx !== -1 ? String(game.opts[idx]).toLowerCase() === game.answer.toLowerCase() : answer.toLowerCase() === game.answer.toLowerCase();
  if (!correct) return { wrong: true };
  economy.addBalance(numFromJid(userJid), 150, 'game_win');
  addWin(userJid);
  end(chatId);
  return { correct: true, answer: game.answer };
}

// Word Chain was replaced by the dedicated WCG implementation in socialGames.js.
// Keeping a second chain state machine here causes command/state collisions, so it
// has intentionally been removed.

// ---------- guess the emoji (multiplayer) ----------
const EMOJI_PUZZLES = [
  { emoji: '🕵️🔍', hint: 'Detective game', a: 'among us' },
  { emoji: '🌞🌊🏖', hint: 'Summer spot', a: 'beach' },
  { emoji: '🍕🧀🍅', hint: 'Italian food', a: 'pizza' },
  { emoji: '🚗🏁', hint: 'Racing', a: 'f1' },
  { emoji: '🎸🎤🎶', hint: 'Live music', a: 'concert' },
  { emoji: '📚🏫🎓', hint: 'School', a: 'student' },
  { emoji: '🌌🚀🪐', hint: 'Outer space', a: 'space' },
  { emoji: '🎬🍿📽', hint: 'Watch films', a: 'cinema' },
  { emoji: '💻⌨️🖱', hint: 'Work tool', a: 'computer' },
  { emoji: '⚽🏆🥅', hint: 'Sport', a: 'football' },
];
function startEmojiGame(chatId, senderJid) {
  const p = EMOJI_PUZZLES[Math.floor(Math.random() * EMOJI_PUZZLES.length)];
  setGame(chatId, { type: 'emoji', puzzle: p, solved: false, host: numFromJid(senderJid), started: Date.now() });
  return { text: `*🎭 Guess the Emoji!*\n${p.emoji}\nHint: ${p.hint}\n\nFirst correct answer wins 100 coins!` };
}
function resolveEmojiGame(chatId, userJid, guess) {
  const game = current(chatId);
  if (!game || game.type !== 'emoji' || game.solved) return null;
  if (guess.toLowerCase() === game.puzzle.a) {
    game.solved = true;
    economy.addBalance(numFromJid(userJid), 100, 'game_win');
    addWin(userJid);
    end(chatId);
    return { correct: true, answer: game.puzzle.a };
  }
  return { wrong: true };
}

// ---------- would you rather (multiplayer vote) ----------
const WYR = [
  ['Have the ability to fly', 'Be invisible at will'],
  ['Never need sleep', 'Never need to eat'],
  ['Be super strong', 'Be super smart'],
  ['Travel to the past', 'Travel to the future'],
  ['Have infinite money', 'Have infinite time'],
  ['Be famous', 'Be rich but unknown'],
  ['Speak all languages', 'Play every instrument'],
  ['Read minds', 'See the future'],
];
function startWyr(chatId, senderJid) {
  const p = WYR[Math.floor(Math.random() * WYR.length)];
  setGame(chatId, { type: 'wyr', a: p[0], b: p[1], votes: { A: 0, B: 0 }, voters: {}, host: numFromJid(senderJid), started: Date.now() });
  return {
    text: '⚖️ *Would You Rather?*\nTap an option on the poll, or reply *A* / *B*.',
    poll: {
      name: 'Would You Rather?',
      values: [String(p[0]).slice(0, 100), String(p[1]).slice(0, 100)],
      selectableCount: 1,
    },
  };
}
function resolveWyr(chatId, userJid, vote) {
  const game = current(chatId);
  if (!game || game.type !== 'wyr') return null;
  const v = vote.toUpperCase();
  if (v !== 'A' && v !== 'B') return { invalid: true };
  const num = numFromJid(userJid);
  if (game.voters[num]) return { voted: true };
  game.voters[num] = v;
  game.votes[v]++;
  setGame(chatId, game);
  return { vote: v, totalA: game.votes.A, totalB: game.votes.B };
}

// ---------- word grid (Wordle-style: guess the 5-letter word in 6 tries) ----------
const WORDGRID_WORDS = [
  'apple', 'grape', 'mango', 'peach', 'lemon', 'melon', 'olive', 'plums',
  'chair', 'table', 'couch', 'lamp', 'clock', 'brush', 'towel', 'plate',
  'river', 'ocean', 'cloud', 'storm', 'beach', 'stone', 'forest', 'field',
  'happy', 'brave', 'quiet', 'sharp', 'quick', 'proud', 'eager', 'loyal',
  'music', 'dance', 'paint', 'write', 'dream', 'smile', 'laugh', 'shout',
  'tiger', 'eagle', 'whale', 'zebra', 'horse', 'sheep', 'mouse', 'snake',
].filter((w) => w.length === 5);

// ---------- rock-paper-scissors duel (two real users, optional wager, hidden moves) ----------
const RPS_BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };

function startRpsDuel(chatId, challengerJid, opponentJid, wager = 0) {
  const challengerNum = numFromJid(challengerJid);
  const opponentNum = numFromJid(opponentJid);
  if (challengerNum === opponentNum) return { ok: false, error: "Can't duel yourself." };
  if (wager > 0) {
    const bal = economy.getBalance(challengerNum);
    if (bal < wager) return { ok: false, error: `Not enough to wager ${wager} — you have ${bal}.` };
  }
  setGame(chatId, { type: 'rps', challenger: challengerJid, opponent: opponentJid, wager, choices: {} });
  return {
    ok: true,
    text: `🪨📄✂️ *RPS duel!* ${wager > 0 ? `Wager: ${wager}. ` : ''}Both players reply with rock, paper, or scissors (kept hidden until both are in).`,
  };
}

/** Returns { invalid: true } for a non-participant/bad move, { waiting: true } if only one
 *  side has moved so far, or the final result once both sides are in. */
function resolveRpsDuel(chatId, senderJid, text) {
  const game = current(chatId);
  if (!game || game.type !== 'rps') return null;
  const move = text.toLowerCase().trim();
  if (!['rock', 'paper', 'scissors'].includes(move)) return { invalid: true };

  const senderNum = numFromJid(senderJid);
  const isChallenger = senderNum === numFromJid(game.challenger);
  const isOpponent = senderNum === numFromJid(game.opponent);
  if (!isChallenger && !isOpponent) return { invalid: true, notParticipant: true };

  const role = isChallenger ? 'challenger' : 'opponent';
  if (game.choices[role]) return { invalid: true, alreadyMoved: true };
  game.choices[role] = move;

  if (!game.choices.challenger || !game.choices.opponent) {
    setGame(chatId, game);
    return { waiting: true };
  }

  // both in — resolve
  end(chatId);
  const c = game.choices.challenger, o = game.choices.opponent;
  let winner = null; // 'challenger' | 'opponent' | null (tie)
  if (c !== o) winner = RPS_BEATS[c] === o ? 'challenger' : 'opponent';

  if (game.wager > 0 && winner) {
    const winnerId = winner === 'challenger' ? numFromJid(game.challenger) : numFromJid(game.opponent);
    const loserId = winner === 'challenger' ? numFromJid(game.opponent) : numFromJid(game.challenger);
    economy.addBalance(winnerId, game.wager);
    economy.addBalance(loserId, -game.wager);
  }
  if (winner) { const winnerJid = winner === 'challenger' ? game.challenger : game.opponent; if (!game.wager) economy.addBalance(numFromJid(winnerJid), 100); addWin(winnerJid); }

  return {
    over: true,
    challenger: game.challenger, opponent: game.opponent,
    challengerMove: c, opponentMove: o,
    winner, wager: game.wager,
  };
}

// Old Wordle-style wordgrid removed — "wordgrid" is the visual Word Search below.
async function startWordgrid(chatId, senderJid) {
  return startWordSearch(chatId, senderJid);
}
function resolveWordgrid() {
  return null; // disabled
}

// ---------- Word Search / Word Grid (visual) ----------
const WORDSEARCH_WORDS = [
  // short (3–4)
  'cat', 'dog', 'sun', 'map', 'car', 'box', 'sky', 'run', 'red', 'blue',
  'tree', 'book', 'fish', 'bird', 'moon', 'star', 'fire', 'wind', 'rain', 'snow',
  'wolf', 'bear', 'lion', 'frog', 'duck', 'ship', 'boat', 'road', 'path', 'gate',
  'code', 'game', 'play', 'work', 'home', 'love', 'hope', 'time', 'life', 'mind',
  // 5–6 mixed with existing
  'planet', 'forest', 'castle', 'bridge', 'orange', 'purple', 'silver', 'golden',
  'garden', 'stream', 'flower', 'butter', 'market', 'window', 'summer', 'winter',
  'spring', 'autumn', 'school', 'friend', 'family', 'travel', 'rocket', 'planet',
  'circle', 'square', 'camera', 'guitar', 'violin', 'piano', 'dragon', 'wizard',
  'knight', 'castle', 'pirate', 'island', 'ocean', 'river', 'mountain', 'valley',
  'desert', 'jungle', 'forest', 'animal', 'tiger', 'eagle', 'shark', 'whale',
  'turtle', 'rabbit', 'monkey', 'zebra', 'cookie', 'bread', 'cheese', 'apple',
  'banana', 'orange', 'grape', 'lemon', 'pepper', 'tomato', 'carrot', 'onion',
  'bottle', 'mirror', 'candle', 'pillow', 'blanket', 'jacket', 'button', 'needle',
  'hammer', 'ladder', 'bridge', 'tunnel', 'station', 'airport', 'harbor', 'border',
  'nation', 'empire', 'legend', 'mystery', 'secret', 'puzzle', 'riddle', 'answer',
  'number', 'letter', 'symbol', 'signal', 'energy', 'power', 'force', 'speed',
  'motion', 'shadow', 'bright', 'darkness', 'cloud', 'storm', 'thunder', 'breeze',
  'crystal', 'diamond', 'emerald', 'ruby', 'silver', 'copper', 'bronze', 'metal',
  'pixel', 'screen', 'server', 'client', 'packet', 'binary', 'logic', 'script',
  'python', 'java', 'swift', 'robot', 'drone', 'laser', 'radar', 'sonar',
  'soccer', 'tennis', 'hockey', 'boxing', 'racing', 'player', 'winner', 'trophy',
];
const GRID_SIZE = 8;
const WORD_MIN_LEN = 3;
const WORD_MAX_LEN = 6; // mix of 3, 4, 5, and 6 letter words

function generateWordSearchGrid(wordsToHide, size) {
  const grid = Array.from({ length: size }, () => Array(size).fill(''));
  const directions = [[0,1],[1,0],[1,1],[1,-1],[0,-1],[-1,0],[-1,-1],[-1,1]];
  const placed = [];

  for (const word of wordsToHide) {
    let success = false;
    for (let attempts = 0; attempts < 120 && !success; attempts++) {
      const dir = directions[Math.floor(Math.random() * directions.length)];
      const row = Math.floor(Math.random() * size);
      const col = Math.floor(Math.random() * size);
      const endRow = row + dir[0] * (word.length - 1);
      const endCol = col + dir[1] * (word.length - 1);
      if (endRow < 0 || endRow >= size || endCol < 0 || endCol >= size) continue;
      let ok = true;
      for (let i = 0; i < word.length; i++) {
        const r = row + dir[0] * i;
        const c = col + dir[1] * i;
        if (grid[r][c] !== '' && grid[r][c] !== word[i]) { ok = false; break; }
      }
      if (!ok) continue;
      for (let i = 0; i < word.length; i++) {
        const r = row + dir[0] * i;
        const c = col + dir[1] * i;
        grid[r][c] = word[i];
      }
      placed.push({ word, row, col, dr: dir[0], dc: dir[1] });
      success = true;
    }
  }

  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (grid[r][c] === '') grid[r][c] = letters[Math.floor(Math.random() * letters.length)].toLowerCase();
      else grid[r][c] = String(grid[r][c]).toLowerCase();
    }
  }
  return { grid, placed };
}

function maskWord(word, found) {
  if (found) return `✓ ${String(word).toUpperCase()}`;
  const w = String(word);
  return `○ ${w[0].toUpperCase()}${'—'.repeat(Math.max(0, w.length - 1))}`;
}

function wordListCaption(game) {
  const lines = (game.words || []).map((w) => maskWord(w, (game.found || []).includes(w)));
  const left = (game.words || []).filter((w) => !(game.found || []).includes(w)).length;
  let head = 'Word Grid — find the hidden words!\n';
  if (game.lastFound) {
    head += `Last found: ${String(game.lastFound.word).toUpperCase()} by ${game.lastFound.by}\n`;
  }
  head += '\n';
  return head + lines.join('\n') + `\n\n☆ ${left} Word${left === 1 ? '' : 's'} Are Left`;
}

function roundish(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function escapeXml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Word Grid PNG — letter board only (word list goes in message caption) */
async function renderWordGridImage(game) {
  if (!game || !game.grid) return null;
  if (!Array.isArray(game.found)) game.found = [];
  if (!Array.isArray(game.words)) game.words = [];
  if (!Array.isArray(game.placed)) game.placed = [];
  const size = game.grid.length;
  const cell = 52;
  const pad = 16;
  const gap = 5;
  const board = size * cell + (size - 1) * gap;
  const W = pad * 2 + board;
  const H = pad * 2 + board; // board only — no word list in the image

  // Canvas first
  try {
    const { createCanvas } = require('@napi-rs/canvas');
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#152033';
    roundish(ctx, 4, 4, W - 8, H - 8, 16);
    ctx.fill();
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const x = pad + c * (cell + gap);
        const y = pad + r * (cell + gap);
        ctx.fillStyle = '#0f172a';
        roundish(ctx, x, y, cell, cell, 10);
        ctx.fill();
        ctx.strokeStyle = '#334155';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = '#f8fafc';
        ctx.font = 'bold 24px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(game.grid[r][c]).toUpperCase(), x + cell / 2, y + cell / 2 + 1);
      }
    }
    for (const p of game.placed) {
      if (!game.found.includes(p.word)) continue;
      const x0 = pad + p.col * (cell + gap) + cell / 2;
      const y0 = pad + p.row * (cell + gap) + cell / 2;
      const x1 = pad + (p.col + p.dc * (p.word.length - 1)) * (cell + gap) + cell / 2;
      const y1 = pad + (p.row + p.dr * (p.word.length - 1)) * (cell + gap) + cell / 2;
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
    return canvas.toBuffer('image/png');
  } catch {}

  // sharp SVG fallback
  try {
    const sharp = require('sharp');
    let cells = '';
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const x = pad + c * (cell + gap);
        const y = pad + r * (cell + gap);
        const ch = String(game.grid[r][c]).toUpperCase();
        cells += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="10" fill="#0f172a" stroke="#334155" stroke-width="1.5"/>`;
        cells += `<text x="${x + cell / 2}" y="${y + cell / 2 + 8}" text-anchor="middle" font-size="24" font-family="Arial,Helvetica,sans-serif" font-weight="700" fill="#f8fafc">${escapeXml(ch)}</text>`;
      }
    }
    let strikes = '';
    for (const p of game.placed) {
      if (!game.found.includes(p.word)) continue;
      const x0 = pad + p.col * (cell + gap) + cell / 2;
      const y0 = pad + p.row * (cell + gap) + cell / 2;
      const x1 = pad + (p.col + p.dc * (p.word.length - 1)) * (cell + gap) + cell / 2;
      const y1 = pad + (p.row + p.dr * (p.word.length - 1)) * (cell + gap) + cell / 2;
      strikes += `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" stroke="#ef4444" stroke-width="5" stroke-linecap="round"/>`;
    }
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="100%" height="100%" fill="#0b1220"/>
  <rect x="4" y="4" width="${W - 8}" height="${H - 8}" rx="16" fill="#152033"/>
  ${cells}${strikes}
</svg>`;
    const buf = await sharp(Buffer.from(svg)).png().toBuffer();
    if (buf && buf.length > 500) return buf;
  } catch {}
  return null;
}

function textGridFallback(game) {
  if (!game || !game.grid) return '';
  const rows = game.grid.map((row) => row.map((ch) => String(ch).toUpperCase()).join(' '));
  let caption = 'Word Grid — find the hidden words!\n';
  if (game.lastFound) {
    caption += `Last found: ${String(game.lastFound.word).toUpperCase()} by ${game.lastFound.by}\n`;
  }
  caption += '```\n' + rows.join('\n') + '\n```\n' + wordListCaption(game);
  return caption;
}


async function fetchDictionaryWords(count = 12) {
  const out = new Set();
  const add = (w) => {
    const s = String(w || '').toLowerCase().replace(/[^a-z]/g, '');
    if (s.length >= WORD_MIN_LEN && s.length <= WORD_MAX_LEN) out.add(s);
  };
  const httpGet = (url) => new Promise((resolve) => {
    try {
      const lib = url.startsWith('http://') ? require('http') : require('https');
      const req = lib.get(url, { timeout: 10000, headers: { 'User-Agent': 'NickAI/4.0' } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { try { req.destroy(); } catch {} resolve(null); });
    } catch { resolve(null); }
  });

  // Seed with solid local 5–6 letter words first
  for (const w of shuffle(WORDSEARCH_WORDS || [])) add(w);

  // Datamuse: 5–6 letters with frequency metadata — skip rare junk
  for (const sp of ['???', '????', '?????', '??????']) {
    const data = await httpGet(`https://api.datamuse.com/words?sp=${sp}&max=60&md=f`);
    if (!Array.isArray(data)) continue;
    for (const row of data) {
      const tags = row.tags || [];
      const freqTag = tags.find((x) => String(x).startsWith('f:'));
      const freq = freqTag ? parseFloat(String(freqTag).slice(2)) : 1;
      if (freq < 1) continue; // uncommon
      add(row.word);
    }
  }

  // random-word-api (length-filtered by add())
  try {
    const data = await httpGet('https://random-word-api.herokuapp.com/word?number=50');
    if (Array.isArray(data)) for (const w of data) add(w);
  } catch {}

  const list = shuffle([...out]);
  return list.slice(0, Math.max(count, 12));
}

async function startWordSearch(chatId, senderJid) {
  const existing = current(chatId);
  if (existing && (existing.type === 'wordgrid' || existing.type === 'wordsearch')) {
    return {
      alreadyActive: true,
      text: `🔍 *Word Grid* is already running.\nType a word to find it.\nSay *stop game* to cancel.`,
      game: existing,
      needsImage: true,
    };
  }

  let attempt = [];
  try {
    attempt = await fetchDictionaryWords(16);
  } catch {
    attempt = [];
  }
  attempt = (attempt || [])
    .map((w) => String(w).toLowerCase())
    .filter((w) => w.length >= WORD_MIN_LEN && w.length <= WORD_MAX_LEN);
  if (attempt.length < 8) {
    attempt = shuffle(
      WORDSEARCH_WORDS.map((w) => String(w).toLowerCase())
        .filter((w) => w.length >= WORD_MIN_LEN && w.length <= WORD_MAX_LEN)
    ).slice(0, 16);
  }

  // Balanced mix of 3–6 letter words
  attempt = shuffle(attempt);
  const byLen = { 3: [], 4: [], 5: [], 6: [] };
  for (const w of attempt) {
    if (byLen[w.length]) byLen[w.length].push(w);
  }
  const mixed = [];
  // Pull round-robin so short and long both appear
  for (let i = 0; i < 6; i++) {
    for (const len of [3, 4, 5, 6]) {
      if (byLen[len][i]) mixed.push(byLen[len][i]);
    }
  }
  attempt = (mixed.length >= 8 ? mixed : shuffle(attempt)).slice(0, 16);

  const { grid, placed } = generateWordSearchGrid(attempt, GRID_SIZE);
  const rawList = placed.length ? placed.map((p) => p.word) : attempt.slice(0, 8);
  const wordList = [...new Set(rawList)].filter((w) => w.length >= WORD_MIN_LEN && w.length <= WORD_MAX_LEN);

  const game = {
    type: 'wordgrid', // unified type — no old Wordle
    grid,
    placed,
    words: wordList,
    found: [],
    foundBy: {}, // word -> { userId, name }
    scores: {},  // userId -> count
    lastFound: null,
    host: numFromJid(senderJid),
    started: Date.now(),
  };
  setGame(chatId, game);

  return { text: wordListCaption(game), game, needsImage: true };
}

function resolveWordSearch(chatId, userJid, text, displayName) {
  const game = current(chatId);
  if (!game || (game.type !== 'wordgrid' && game.type !== 'wordsearch')) return null;
  if (!Array.isArray(game.found)) game.found = [];
  if (!Array.isArray(game.words)) game.words = [];
  if (!Array.isArray(game.placed)) game.placed = [];
  if (!game.foundBy || typeof game.foundBy !== 'object') game.foundBy = {};
  if (!game.scores || typeof game.scores !== 'object') game.scores = {};
  if (!game.grid) return { invalid: true, text: null };

  const guess = String(text || '').trim().toLowerCase();
  if (!/^[a-z]{3,12}$/.test(guess)) return { invalid: true, text: null };

  if (game.found.includes(guess)) {
    return { alreadyFound: true, text: `⏳ *${guess.toUpperCase()}* was already found.` };
  }
  if (!game.words.includes(guess)) {
    return { notFound: true, text: null };
  }

  const uid = numFromJid(userJid) || String(userJid || '').split('@')[0];
  const by = displayName || uid || 'player';

  game.found.push(guess);
  game.foundBy[guess] = { userId: uid, name: String(by).slice(0, 24) };
  game.scores[uid] = (game.scores[uid] || 0) + 1;
  game.lastFound = { word: guess, by: String(by).slice(0, 24), userId: uid };

  // Small find reward immediately (linked to same economy wallets as balance/daily)
  const FIND_REWARD = 15;
  try { economy.addBalance(uid, FIND_REWARD); } catch {}

  const remaining = game.words.filter((w) => !game.found.includes(w));

  if (remaining.length === 0) {
    const summary = finishWordGrid(chatId, game);
    return {
      over: true,
      won: true,
      text: summary.text,
      game,
      needsImage: true,
      scores: summary.scores,
      winner: summary.winner,
    };
  }

  setGame(chatId, game);
  return {
    found: guess,
    remaining,
    text: wordListCaption(game) + `\n\n💰 +${FIND_REWARD} ${economy.CUR}`,
    game,
    needsImage: true,
  };
}

/** Rank finders, pay top winner + runners-up via economy wallets */
function finishWordGrid(chatId, game) {
  const scores = { ...(game.scores || {}) };
  const ranked = Object.entries(scores)
    .map(([userId, count]) => ({ userId, count: Number(count) || 0 }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count);

  const TOP_PRIZE = 150;
  const SECOND = 80;
  const THIRD = 40;

  let winner = null;
  const payouts = [];

  if (ranked[0]) {
    winner = ranked[0];
    try {
      economy.addBalance(winner.userId, TOP_PRIZE);
      addWin(winner.userId);
    } catch {}
    payouts.push({ ...winner, prize: TOP_PRIZE, place: 1 });
  }
  if (ranked[1]) {
    try { economy.addBalance(ranked[1].userId, SECOND); } catch {}
    payouts.push({ ...ranked[1], prize: SECOND, place: 2 });
  }
  if (ranked[2]) {
    try { economy.addBalance(ranked[2].userId, THIRD); } catch {}
    payouts.push({ ...ranked[2], prize: THIRD, place: 3 });
  }

  end(chatId);

  const scoreLines = ranked.length
    ? ranked.map((r, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
        const bonus = payouts.find((p) => p.userId === r.userId);
        const extra = bonus ? ` → +${bonus.prize} ${economy.CUR}` : '';
        return `${medal} ${r.userId} — *${r.count}* word${r.count === 1 ? '' : 's'}${extra}`;
      }).join('\n')
    : 'No scores recorded.';

  const winLine = winner
    ? `\n🏆 *Winner:* ${winner.userId} (${winner.count} words) +${TOP_PRIZE} ${economy.CUR}`
    : '';

  const text =
    `🎉 *All words found!*\n` +
    wordListCaption({ ...game, found: [...(game.words || [])] }) +
    `\n\n📊 *Final scores*\n${scoreLines}` +
    winLine +
    `\n\nCoins go to the same wallet as *balance* / *daily*.`;

  return { text, scores: ranked, winner, payouts };
}


// ---------- Crossword ----------
const CROSSWORD_PUZZLES = [
  {
    title: 'Everyday',
    clues: [
      { id: 1, dir: 'Across', clue: 'Hot drink from beans (6)', answer: 'coffee' },
      { id: 2, dir: 'Across', clue: 'Opposite of night (3)', answer: 'day' },
      { id: 3, dir: 'Down', clue: 'You type on this (8)', answer: 'keyboard' },
      { id: 4, dir: 'Across', clue: 'Red fruit, keeps doctor away (5)', answer: 'apple' },
      { id: 5, dir: 'Down', clue: 'Falls from clouds (4)', answer: 'rain' },
    ],
  },
  {
    title: 'Animals',
    clues: [
      { id: 1, dir: 'Across', clue: 'King of the jungle (4)', answer: 'lion' },
      { id: 2, dir: 'Down', clue: 'Man\'s best friend (3)', answer: 'dog' },
      { id: 3, dir: 'Across', clue: 'Black and white bear (5)', answer: 'panda' },
      { id: 4, dir: 'Across', clue: 'Striped big cat (5)', answer: 'tiger' },
      { id: 5, dir: 'Down', clue: 'Bird that cannot fly, loves ice (7)', answer: 'penguin' },
    ],
  },
  {
    title: 'Places',
    clues: [
      { id: 1, dir: 'Across', clue: 'Capital of France (5)', answer: 'paris' },
      { id: 2, dir: 'Down', clue: 'Largest ocean (7)', answer: 'pacific' },
      { id: 3, dir: 'Across', clue: 'Country of the pyramids (5)', answer: 'egypt' },
      { id: 4, dir: 'Across', clue: 'City with Big Ben (6)', answer: 'london' },
      { id: 5, dir: 'Down', clue: 'Continent of Nigeria (6)', answer: 'africa' },
    ],
  },
  {
    title: 'Tech',
    clues: [
      { id: 1, dir: 'Across', clue: 'World Wide ___ (3)', answer: 'web' },
      { id: 2, dir: 'Down', clue: 'Message app this bot runs on (8)', answer: 'whatsapp' },
      { id: 3, dir: 'Across', clue: 'Storage in the ___ (5)', answer: 'cloud' },
      { id: 4, dir: 'Across', clue: 'Clickable address (3)', answer: 'url' },
      { id: 5, dir: 'Down', clue: 'Bug in software (5)', answer: 'error' },
    ],
  },
];

function crosswordBoardText(game) {
  const lines = game.clues.map((c) => {
    const done = game.solved.includes(c.id);
    const ans = done ? c.answer.toUpperCase() : '_'.repeat(c.answer.length);
    return `${done ? '✅' : '⬜'} *${c.id}.* ${c.dir} — ${c.clue}\n   \`${ans}\``;
  });
  const left = game.clues.length - game.solved.length;
  return (
    `🧩 *Crossword — ${game.title}*\n\n` +
    lines.join('\n\n') +
    `\n\n☆ ${left} clue${left === 1 ? '' : 's'} left\n` +
    `Type an answer (e.g. *coffee*). First correct claim wins coins!`
  );
}

function startCrossword(chatId, senderJid) {
  const puzzle = CROSSWORD_PUZZLES[Math.floor(Math.random() * CROSSWORD_PUZZLES.length)];
  const clues = puzzle.clues.map((c) => ({ ...c, answer: c.answer.toLowerCase() }));
  const game = {
    type: 'crossword',
    title: puzzle.title,
    clues,
    solved: [],
    solvedBy: {},
    scores: {},
    host: numFromJid(senderJid),
    started: Date.now(),
  };
  setGame(chatId, game);
  return { text: crosswordBoardText(game), ttl: 5 * 60 * 1000, game };
}

function resolveCrossword(chatId, userJid, text, displayName) {
  const game = current(chatId);
  if (!game || game.type !== 'crossword') return null;
  if (!Array.isArray(game.solved)) game.solved = [];
  if (!game.scores) game.scores = {};

  const guess = String(text || '').trim().toLowerCase().replace(/[^a-z]/g, '');
  if (guess.length < 2 || guess.length > 16) return { invalid: true };

  const hit = game.clues.find((c) => c.answer === guess && !game.solved.includes(c.id));
  if (!hit) {
    // already solved answer?
    if (game.clues.some((c) => c.answer === guess)) {
      return { already: true, text: `⏳ *${guess.toUpperCase()}* was already solved.` };
    }
    return { notFound: true }; // silent
  }

  const uid = numFromJid(userJid) || String(userJid).split('@')[0];
  const by = displayName || uid;
  game.solved.push(hit.id);
  game.solvedBy[hit.id] = { userId: uid, name: String(by).slice(0, 24) };
  game.scores[uid] = (game.scores[uid] || 0) + 1;

  const CLUE_REWARD = 25;
  try { economy.addBalance(uid, CLUE_REWARD); } catch {}

  if (game.solved.length >= game.clues.length) {
    const ranked = Object.entries(game.scores)
      .map(([userId, count]) => ({ userId, count }))
      .sort((a, b) => b.count - a.count);
    const TOP = 120;
    if (ranked[0]) {
      try {
        economy.addBalance(ranked[0].userId, TOP);
        addWin(ranked[0].userId);
      } catch {}
    }
    end(chatId);
    const scoreLines = ranked
      .map((r, i) => `${i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉'} ${r.userId} — ${r.count} clue${r.count === 1 ? '' : 's'}${i === 0 ? ` +${TOP} ${economy.CUR}` : ''}`)
      .join('\n');
    return {
      over: true,
      text:
        `🎉 *Crossword complete — ${game.title}!*\n\n` +
        crosswordBoardText({ ...game, solved: game.clues.map((c) => c.id) }) +
        `\n\n📊 *Scores*\n${scoreLines}\n` +
        (ranked[0] ? `🏆 Winner: ${ranked[0].userId}` : ''),
    };
  }

  setGame(chatId, game);
  return {
    found: hit.answer,
    text: `✅ *${hit.answer.toUpperCase()}* by ${by} (+${CLUE_REWARD} ${economy.CUR})\n\n` + crosswordBoardText(game),
  };
}

// ---------- Spelling Bee ----------
const SPELL_WORDS = [
  'accommodation','acknowledgment','acquaintance','achievement','aggressive','apparent','argument',
  'beautiful','beginning','believe','calendar','camouflage','cemetery','chauffeur','colleague',
  'conscience','conscious','consensus','courageous','curiosity','definitely','discipline','embarrass',
  'environment','exaggerate','excellent','experience','fascinating','familiar','foreign','friendship',
  'gauge','government','grateful','guarantee','harassment','height','hierarchy','humorous','ignorance',
  'immediately','independent','indispensable','intelligence','jewelry','judgment','knowledge','language',
  'leisure','liaison','library','maintenance','maneuver','medieval','millennium','necessary','neighbor',
  'noticeable','occasionally','occurrence','parallel','parliament','perseverance','personnel','phenomenon',
  'possession','privilege','pronunciation','questionnaire','recommend','reference','rehearsal','relevant',
  'restaurant','rhythm','schedule','separate','signature','successful','supersede','surprise','threshold',
  'tomorrow','twelfth','vacuum','weird','withhold','bureaucracy','conscience','miscellaneous','pneumonia',
  'rhythmical','silhouette','unforeseen','vocabulary','yacht','zucchini','entrepreneur','psychiatrist',
  'quarantine','rhinoceros','sacrilegious','temperature','unconscious','versatile','whimsical','xylophone',
  'abysmal','benevolent','catastrophic','diligent','eloquent','formidable','gregarious','hypothesis',
  'illuminate','juxtapose','kaleidoscope','labyrinth','meticulous','nostalgia','omnipotent','paradox',
  'quintessential','resilient','serendipity','tenacious','ubiquitous','venerable','wistful','zealous',
];

function startSpellingBee(chatId, senderJid) {
  const word = SPELL_WORDS[Math.floor(Math.random() * SPELL_WORDS.length)];
  setGame(chatId, {
    type: 'spellingbee',
    word,
    host: numFromJid(senderJid),
    starter: String(senderJid),
    started: Date.now(),
    ttl: 60000,
    reward: 500,
  });
  return {
    text: '🐝 *Spelling Bee!*\n\nListen to the voice note. Reply with the correct spelling within *60 seconds* to win *500* coins.\n(Audio may auto-delete after ~20s.)',
    // Edge TTS generates a real mp3 buffer (Google translate_tts often fails in WA)
    ttsText: word,
    ttsVoice: process.env.TTS_VOICE || 'en-US-JennyNeural',
    deleteAudioAfterMs: 20000,
    reward: 500,
  };
}

function resolveSpellingBee(chatId, userJid, text) {
  const game = current(chatId);
  if (!game || game.type !== 'spellingbee') return null;
  const answer = String(text || '').trim().toLowerCase().replace(/[^a-z]/g, '');
  if (!answer) return { handled: true, text: '✏️ Type the spelling of the word you heard.' };
  // Only the person who started (or anyone in group) can answer — allow anyone
  if (answer === game.word.toLowerCase()) {
    const reward = game.reward || 500;
    try { economy.addBalance(numFromJid(userJid), reward); } catch {}
    end(chatId);
    return {
      handled: true,
      correct: true,
      text: `🎉 *Correct!* The word was *${game.word}*.\n💰 +${reward} ${economy.CUR || 'coins'}`,
    };
  }
  end(chatId);
  return {
    handled: true,
    correct: false,
    text: `❌ *Wrong!* The correct spelling was *${game.word}*.`,
  };
}

module.exports = {
  current, setGame, end, addWin, leaderboard,
  startTrivia, startScramble, startCrossword, resolveCrossword, startGuess, startRiddle, startBlackjack, startCoinflip,
  resolveAnswer, resolveGuess, resolveBlackjack, resolveCoinflip,
  startTtt, resolveTtt, startHangman, resolveHangman,
  startSlot, resolveSlot, startQuiz, resolveQuiz,
  startEmojiGame, resolveEmojiGame, startWyr, resolveWyr, startSpellingBee, resolveSpellingBee,
  startWordgrid, resolveWordgrid,
  startWordSearch, resolveWordSearch, finishWordGrid, renderWordGridImage, textGridFallback,
  // Interactive HTML games surface (for agent awareness)
  listInteractiveGames: () => { try { return require('./interactiveGames').listGames(); } catch { return []; } },
  launchInteractive: async (...a) => { try { return require('./interactiveGames').launch(...a); } catch (e) { return { ok: false, text: e.message }; } },

  startRpsDuel, resolveRpsDuel,
};

});

runtime.define("interactiveGames", "interactiveGames.js", function(module, exports, require, __filename, __dirname) {
// Optional interactive-game pack placeholder. The base distribution does not
// include third-party interactive game assets, so the feature remains safely off.
function listGames() {
  return [];
}

async function launch() {
  return {
    ok: false,
    text: 'Interactive games are not bundled in this distribution.',
  };
}

module.exports = { listGames, launch };

});

runtime.define("leveling", "leveling.js", function(module, exports, require, __filename, __dirname) {
// Deterministic, no AI involved — a fixed XP amount per message with a short cooldown so
// spamming doesn't inflate levels, and a simple increasing curve for how much each level costs.
const { Collection } = require('../db');
const config = require('../config');
const achievements = require('./achievements');

const xpStore = new Collection('leveling_xp', {}); // userId -> { xp, level, lastGainAt }
const XP_PER_MESSAGE = config.leveling?.xpPerMessage ?? 15;
const XP_COOLDOWN_MS = (config.leveling?.cooldownSeconds ?? 45) * 1000;
const settingsStore = new Collection('leveling_settings', { enabled: false });
function isEnabled() { return false; /* agent mode: leveling hard-off */ }
function setEnabled(enabled) { settingsStore.set('enabled', !!enabled); return !!enabled; }

/** XP required to reach a given level (cumulative), roughly quadratic so it slows down. */
function xpForLevel(level) {
  return Math.round(50 * Math.pow(level, 1.6));
}

function levelForXp(xp) {
  let level = 0;
  while (xpForLevel(level + 1) <= xp) level++;
  return level;
}

function get(userId) {
  return xpStore.get(userId, { xp: 0, level: 0, lastGainAt: 0 });
}

/**
 * Call on every message from a user. Returns { gained, leveledUp, newLevel } — gained is 0
 * if still on cooldown (no XP awarded, but nothing breaks).
 */
function onMessage(userId) {
  if (!isEnabled()) return { gained: 0, leveledUp: false, newLevel: get(userId).level, disabled: true };
  const rec = get(userId);
  const now = Date.now();
  if (now - rec.lastGainAt < XP_COOLDOWN_MS) {
    return { gained: 0, leveledUp: false, newLevel: rec.level };
  }
  const prevLevel = rec.level;
  rec.xp += XP_PER_MESSAGE;
  rec.level = levelForXp(rec.xp);
  rec.lastGainAt = now;
  xpStore.set(userId, rec);
  const leveledUp = rec.level > prevLevel;
  let achievement = null;
  if (leveledUp && rec.level >= 25) {
    achievement = achievements.unlock(userId, 'level_25');
  } else if (leveledUp && rec.level >= 10) {
    achievement = achievements.unlock(userId, 'level_10');
  }
  return { gained: XP_PER_MESSAGE, leveledUp, newLevel: rec.level, achievement };
}

function profile(userId) {
  const rec = get(userId);
  const currentLevelXp = xpForLevel(rec.level);
  const nextLevelXp = xpForLevel(rec.level + 1);
  return {
    xp: rec.xp,
    level: rec.level,
    xpIntoLevel: rec.xp - currentLevelXp,
    xpToNextLevel: nextLevelXp - rec.xp,
  };
}

function leaderboard(limit = 10) {
  const all = xpStore.all();
  return Object.entries(all)
    .sort((a, b) => b[1].xp - a[1].xp)
    .slice(0, limit)
    .map(([userId, rec]) => ({ userId, xp: rec.xp, level: rec.level }));
}

module.exports = { onMessage, profile, leaderboard, xpForLevel, isEnabled, setEnabled };

});

runtime.define("partyExtras", "partyExtras.js", function(module, exports, require, __filename, __dirname) {
const { Collection } = require('../db');
const economy = require('./economy');
const { numFromJid } = require('../utils/helpers');

const dates = new Collection('couple_dates', {});
const tournaments = new Collection('tournaments', {});
const seasons = new Collection('quiz_seasons', {});
const langPrefs = new Collection('user_lang', {});

const DATE_IDEAS = [
  'Cook a meal together on video call',
  'Pick a movie and watch “together” (same start time)',
  '30-minute walk + voice notes of what you see',
  'Share 3 childhood photos and stories',
  'Play couple quiz in this group',
  'Write each other a short letter in chat',
];

function dateNight(userA, userB) {
  const idea = DATE_IDEAS[Math.floor(Math.random() * DATE_IDEAS.length)];
  const key = [numFromJid(userA), numFromJid(userB)].sort().join(':');
  const entry = { idea, at: Date.now(), a: numFromJid(userA), b: numFromJid(userB) };
  dates.set(key, entry);
  economy.addBalance(numFromJid(userA), 25);
  economy.addBalance(numFromJid(userB), 25);
  return { ok: true, idea, bonus: 25, message: `💘 Date night idea:\n*${idea}*\n\nBoth of you get +25 coins. Have fun.` };
}

function startTournament(chatId, hostJid, game = 'trivia', maxPlayers = 8) {
  tournaments.set(chatId, {
    game, host: numFromJid(hostJid), players: [numFromJid(hostJid)],
    maxPlayers, started: Date.now(), status: 'lobby', scores: {},
  });
  return {
    ok: true,
    text: `🏆 Tournament lobby open (${game})\nHost started it. Send *join tournament* to enter (${maxPlayers} max).\nHost: *start tournament* when ready.`,
  };
}

function joinTournament(chatId, userJid) {
  const t = tournaments.get(chatId, null);
  if (!t || t.status !== 'lobby') return { ok: false, error: 'No open tournament lobby.' };
  const id = numFromJid(userJid);
  if (t.players.includes(id)) return { ok: true, text: 'You already joined.' };
  if (t.players.length >= t.maxPlayers) return { ok: false, error: 'Lobby full.' };
  t.players.push(id);
  tournaments.set(chatId, t);
  return { ok: true, text: `✅ Joined tournament (${t.players.length}/${t.maxPlayers}).` };
}

function beginTournament(chatId, hostJid) {
  const t = tournaments.get(chatId, null);
  if (!t || t.status !== 'lobby') return { ok: false, error: 'No lobby.' };
  if (numFromJid(hostJid) !== t.host) return { ok: false, error: 'Only the host can start.' };
  if (t.players.length < 2) return { ok: false, error: 'Need at least 2 players.' };
  t.status = 'live';
  t.scores = Object.fromEntries(t.players.map((p) => [p, 0]));
  tournaments.set(chatId, t);
  return {
    ok: true,
    text: `🏁 Tournament LIVE — ${t.players.length} players.\nPlay normal *${t.game}* rounds; first to 3 correct answers wins (tracked via *tour score*).\nOr just play free-form and host calls *end tournament @winner*.`,
  };
}

function tournamentScore(chatId, userJid, points = 1) {
  const t = tournaments.get(chatId, null);
  if (!t || t.status !== 'live') return null;
  const id = numFromJid(userJid);
  if (!t.scores[id] && t.scores[id] !== 0) return null;
  t.scores[id] = (t.scores[id] || 0) + points;
  tournaments.set(chatId, t);
  if (t.scores[id] >= 3) {
    economy.addBalance(id, 300);
    tournaments.delete(chatId);
    return { won: true, text: `🏆 Tournament over! Winner gets +300 coins.` };
  }
  return { won: false, score: t.scores[id], text: `📊 Score: ${t.scores[id]}/3` };
}

function endTournament(chatId, winnerJid) {
  const t = tournaments.get(chatId, null);
  if (!t) return { ok: false, error: 'No tournament.' };
  tournaments.delete(chatId);
  if (winnerJid) {
    economy.addBalance(numFromJid(winnerJid), 300);
    return { ok: true, text: `🏆 Tournament closed. Winner +300 coins.` };
  }
  return { ok: true, text: 'Tournament closed with no winner.' };
}

// Quiz seasons
function seasonState() {
  return seasons.get('current', { id: 1, name: 'Season 1', points: {}, started: Date.now() });
}

function addSeasonPoints(userJid, pts = 10) {
  const s = seasonState();
  const id = numFromJid(userJid);
  s.points[id] = (s.points[id] || 0) + pts;
  seasons.set('current', s);
  return s.points[id];
}

function seasonLeaderboard(limit = 10) {
  const s = seasonState();
  return Object.entries(s.points || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, pts], i) => `${i + 1}. ${id} — ${pts} pts`);
}

function newSeason(name) {
  const cur = seasonState();
  const next = { id: (cur.id || 1) + 1, name: name || `Season ${(cur.id || 1) + 1}`, points: {}, started: Date.now() };
  seasons.set('current', next);
  return next;
}

function setLang(userJid, lang) {
  const code = String(lang || 'en').toLowerCase().slice(0, 8);
  langPrefs.set(numFromJid(userJid), code);
  return code;
}

function getLang(userJid) {
  return langPrefs.get(numFromJid(userJid), 'en');
}

module.exports = {
  dateNight, startTournament, joinTournament, beginTournament, tournamentScore, endTournament,
  addSeasonPoints, seasonLeaderboard, newSeason, seasonState, setLang, getLang, DATE_IDEAS,
};

});

runtime.define("scheduledLeaderboard", "scheduledLeaderboard.js", function(module, exports, require, __filename, __dirname) {
// (daily or weekly), rendered as the same canvas bar-chart image as canvas_leaderboard_card.
// Same interval-scheduler pattern as reminders.js/birthdays.js.
const { Collection } = require('../db');
const logger = require('../logger');

const store = new Collection('scheduled_leaderboard', {}); // chatId -> { enabled, kind, frequency, lastPostedKey }

const DEFAULTS = { enabled: false, kind: 'level', frequency: 'weekly' }; // frequency: 'daily' | 'weekly'

function getSettings(chatId) {
  return { ...DEFAULTS, ...store.get(chatId, {}) };
}

function updateSettings(chatId, patch) {
  return store.update(chatId, (cur = {}) => ({ ...DEFAULTS, ...cur, ...patch }));
}

/** A key that changes once per day (daily) or once per ISO week (weekly), so we can tell
 *  "have I already posted for this period" without a precise cron. */
function periodKey(frequency, date) {
  if (frequency === 'daily') {
    return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
  }
  // ISO week number
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${week}`;
}

const CHECK_MS = 60 * 60 * 1000; // hourly is plenty for daily/weekly posts
let timer = null;

/** postFn(chatId, kind) is provided by the caller (index.js) so this module doesn't need
 *  to know how to render a canvas card or reach the socket directly. */
function startScheduler(postFn) {
  if (timer) return;
  timer = setInterval(async () => {
    const now = new Date();
    const all = store.all();
    for (const [chatId, rec] of Object.entries(all)) {
      const settings = { ...DEFAULTS, ...rec };
      if (!settings.enabled) continue;
      const key = periodKey(settings.frequency, now);
      if (rec.lastPostedKey === key) continue;
      try {
        await postFn(chatId, settings.kind);
        store.set(chatId, { ...rec, lastPostedKey: key });
      } catch (e) {
        logger.warn({ err: e.message, chatId }, 'scheduledLeaderboard: post failed');
      }
    }
  }, CHECK_MS);
}

module.exports = { getSettings, updateSettings, startScheduler };

});
};
