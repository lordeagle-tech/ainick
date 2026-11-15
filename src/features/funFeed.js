// features/funFeed.js — memes / tweet-style cards / debate / comedy
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
