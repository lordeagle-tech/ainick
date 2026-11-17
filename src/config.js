try {
  require('dotenv').config();
} catch (err) {
  // Keep startup resilient if npm install was interrupted. Pterodactyl will
  // install dotenv on the next dependency pass; basic KEY=VALUE parsing lets
  // the process still boot with an existing .env in the meantime.
  const fs = require('fs');
  const path = require('path');
  try {
    const envFile = path.join(process.cwd(), '.env');
    if (fs.existsSync(envFile)) {
      for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (m && process.env[m[1]] === undefined) {
          process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
        }
      }
    }
  } catch {}
}

function list(v) {
  return String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// dotenv last-wins: a trailing empty OWNER_IDS= would wipe owners. Prefer non-empty.
function loadOwnerIds() {
  const raw = process.env.OWNER_IDS || process.env.OWNER_NUMBERS || process.env.BOT_OWNER || '';
  const ids = list(raw).map((n) => n.replace(/\D/g, '')).filter(Boolean);
  for (const k of ['OWNER_ID', 'OWNER_NUMBER', 'OWNER', 'WHATSAPP_OWNER', 'BOT_OWNER_NUMBER']) {
    const single = String(process.env[k] || '').replace(/\D/g, '');
    if (single) ids.push(single);
  }
  // Pairing number is often the owner phone
  const pair = String(process.env.WHATSAPP_PAIRING_NUMBER || '').replace(/\D/g, '');
  if (pair && pair.length >= 10) ids.push(pair);

  const expand = (d) => {
    const set = new Set();
    if (!d) return set;
    set.add(d);
    // 2340XXXXXXXXX → 234XXXXXXXXX (extra 0 after country code — common paste error)
    if (d.startsWith('2340') && d.length >= 14) set.add('234' + d.slice(4));
    if (d.startsWith('0') && d.length >= 10) set.add(d.slice(1));
    // National without country code
    if (d.startsWith('234') && d.length >= 13) set.add(d.slice(3));
    // With leading 0 national
    if (d.startsWith('234') && d.length >= 13) set.add('0' + d.slice(3));
    // Last 10–13 digits
    for (const n of [10, 11, 12, 13]) {
      if (d.length >= n) set.add(d.slice(-n));
    }
    return set;
  };

  const out = new Set();
  for (const d of ids) {
    for (const x of expand(d)) out.add(x);
  }
  return [...out];
}


/** Collect every Agnes key from env (supports 3+ keys for rotation / rate-limit avoidance). */
function collectAgnesKeys() {
  const keys = [];
  const push = (v) => {
    if (v == null || v === '') return;
    String(v).split(/[,\s]+/).map((s) => s.trim()).filter(Boolean).forEach((k) => {
      if (!keys.includes(k)) keys.push(k);
    });
  };
  push(process.env.AGNES_API_KEY);
  push(process.env.AGNES_API_KEY_2);
  push(process.env.AGNES_API_KEY_3);
  push(process.env.AGNES_API_KEY_4);
  push(process.env.AGNES_API_KEY_5);
  push(process.env.AGNES_API_KEYS);
  push(process.env.AI_API_KEY);
  return keys;
}

const config = {
  whatsapp: {
    pairingNumber: process.env.WHATSAPP_PAIRING_NUMBER || '',
  },
  ownerIds: loadOwnerIds(),
  ai: {
    // Agnes AI is the default brain now (OpenAI-compatible). AGNES_API_KEY is the primary
    // var; AI_API_KEY is kept as a fallback so older .env files still work.
    apiKeys: collectAgnesKeys(),
    apiKey: process.env.AGNES_API_KEY || process.env.AI_API_KEY || '',
    baseUrl: (process.env.AI_BASE_URL || 'https://apihub.agnes-ai.com/v1').replace(/\/$/, ''),
    // Chat/vision model. 2.5 Flash is a gray-release upgrade of 2.0 Flash — if the API key
    // isn't enrolled yet, requests automatically fall back to `fallbackModel` below.
    model: process.env.AI_MODEL || 'agnes-2.5-flash',
    fallbackModel: process.env.AI_FALLBACK_MODEL || 'agnes-2.0-flash',
    imageModel: process.env.AI_IMAGE_MODEL || 'agnes-image-2.1-flash',
    videoModel: process.env.AI_VIDEO_MODEL || 'agnes-video-v2.0',
    // Allow multi-step jobs to inspect, edit, test, and report in one turn.
    maxToolSteps: Number(process.env.AI_MAX_TOOL_STEPS || 40),
    // HTTP timeout for chat/completions (ms). Website/project builds need long generations — default 5 min.
    httpTimeoutMs: Number(process.env.AI_HTTP_TIMEOUT_MS || 300000),
    videoPollTimeoutMs: Number(process.env.AI_VIDEO_POLL_TIMEOUT_MS || 600000),
    videoPollIntervalMs: Number(process.env.AI_VIDEO_POLL_INTERVAL_MS || 5000),
    // Owner-switchable direct vendor endpoints only; Anthropic/OpenAI use their own keys, not impersonating proxies.
    // Groq is the default provider; AI_DEFAULT_PROVIDER can override it and configured vendors remain available as fallbacks.
    providerChain: (() => {
      const fromEnv = (process.env.AI_PROVIDER_CHAIN || '')
        .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      // Groq first for Nick AI; provider keys remain individually configured.
      const defaults = ['groq', 'agnes', 'agnes-claude'];
      const seen = new Set();
      const out = [];
      for (const n of [...fromEnv, ...defaults]) {
        if (!n || seen.has(n)) continue;
        if (['openai', 'anthropic', 'grok', 'xai', 'gpt', 'stability'].includes(n)) continue;
        seen.add(n);
        out.push(n);
      }
      return out;
    })(),
    // Coding / sub-agent failover (NOT main chat). Override: AI_CODING_CHAIN=apmix,agentrouter,groq,...
    codingChain: (() => {
      const fromEnv = (process.env.AI_CODING_CHAIN || '')
        .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      const defaults = [
        'apmix', 'agentrouter', 'nvidia', 'groq', 'gemini', 'agnes-claude', 'agnes',
      ];
      const ban = new Set(['openai', 'anthropic', 'grok', 'xai', 'gpt', 'stability']);
      const seen = new Set();
      const out = [];
      for (const n of [...fromEnv, ...defaults]) {
        if (!n || seen.has(n) || ban.has(n)) continue;
        seen.add(n);
        out.push(n);
      }
      return out;
    })(),
    // Groq is Nick AI's default brain unless explicitly overridden.
    defaultProvider: (() => {
      const explicit = (process.env.AI_DEFAULT_PROVIDER || process.env.AI_PROVIDER || '').trim().toLowerCase();
      if (explicit && !['openai', 'anthropic', 'grok', 'xai'].includes(explicit)) return explicit;
      return 'groq';
    })(),
    providers: {
      agnes: {
        label: 'Agnes AI (default)',
        baseUrl: (process.env.AI_BASE_URL || 'https://apihub.agnes-ai.com/v1').replace(/\/$/, ''),
        apiKeys: collectAgnesKeys(),
        model: process.env.AI_MODEL || 'agnes-2.5-flash',
        fallbackModel: process.env.AI_FALLBACK_MODEL || 'agnes-2.0-flash',
        style: 'openai', // request/response shape
      },
      // Claude-style aliases use Agnes's OpenAI-compatible route and Agnes model IDs, not native Anthropic IDs.
      'agnes-claude': {
        label: 'Agnes AI → Claude-style route',
        baseUrl: (process.env.AI_BASE_URL || 'https://apihub.agnes-ai.com/v1').replace(/\/$/, ''),
        apiKeys: collectAgnesKeys(),
        model: process.env.AGNES_CLAUDE_MODEL || process.env.AI_MODEL || 'agnes-2.5-flash',
        fallbackModel: process.env.AGNES_CLAUDE_FALLBACK_MODEL || 'agnes-2.0-flash',
        style: 'openai',
      },
      nvidia: {
        label: 'NVIDIA NIM',
        baseUrl: (process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/$/, ''),
        apiKeys: [process.env.NVIDIA_API_KEY].filter(Boolean),
        model: process.env.NVIDIA_MODEL || 'deepseek-ai/deepseek-v4-flash',
        fallbackModel: process.env.NVIDIA_FALLBACK_MODEL || 'openai/gpt-oss-20b',
        style: 'openai',
      },
      // Local Ollama — ONLY enabled when OLLAMA_ENABLED=true or OLLAMA_BASE_URL is set.
      // Default off so panels without Ollama do not spam ECONNREFUSED 127.0.0.1:11434.
      // Qwen has been removed; use llama or another local model if you enable Ollama.
      ...(process.env.OLLAMA_ENABLED === 'true' || process.env.OLLAMA_BASE_URL ? {
      ollama: {
        label: 'Ollama (local, free, no API key)',
        baseUrl: (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/v1').replace(/\/$/, ''),
        apiKeys: ['local'],
        model: process.env.OLLAMA_MODEL || 'llama3.2:3b',
        fallbackModel: process.env.OLLAMA_FALLBACK_MODEL || 'llama3.2:1b',
        style: 'openai',
        local: true,
      },
      } : {}),
      // Groq — fast OpenAI-compatible inference. Set GROQ_API_KEY (console.groq.com).
      groq: {
        label: 'Groq (fast inference)',
        baseUrl: (process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, ''),
        apiKeys: String(process.env.GROQ_API_KEY || '').split(',').map(k => k.trim()).filter(Boolean),
        model: process.env.GROQ_MODEL || 'qwen/qwen3.8-27b',
        visionModel: process.env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b',
        // Keep fallback configurable; use a verified, account-available backup by default.
        fallbackModel: process.env.GROQ_FALLBACK_MODEL || 'openai/gpt-oss-20b',
        style: 'openai',
      },
      // Google Gemini — OpenAI-compatible endpoint. Set GEMINI_API_KEY or GOOGLE_API_KEY.
      gemini: {
        label: 'Gemini (Google)',
        baseUrl: (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/$/, ''),
        apiKeys: [process.env.GEMINI_API_KEY, process.env.GOOGLE_API_KEY].filter(Boolean),
        model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
        fallbackModel: process.env.GEMINI_FALLBACK_MODEL || 'gemini-1.5-flash',
        style: 'openai',
      },
      // Apmix.ai — free tier (deepseek-v4-flash-free + space-bunny-free) + paid models.
      // OpenAI-compatible. Docs: https://apmix.ai/docs  Base: https://api.apmix.ai/v1
      // Free models are ideal coding fallbacks when AgentRouter/Agnes keys are missing or rate-limited.
      apmix: {
        label: 'Apmix.ai (DeepSeek V4 Flash Free + Space Bunny Free)',
        baseUrl: (process.env.APMIX_BASE_URL || 'https://api.apmix.ai/v1').replace(/\/$/, ''),
        apiKeys: [process.env.APMIX_API_KEY, process.env.APMIX_KEY].filter(Boolean),
        // Latest free coding model first; space-bunny-free as secondary free fallback
        model: process.env.APMIX_MODEL || 'deepseek-v4-flash-free',
        fallbackModel: process.env.APMIX_FALLBACK_MODEL || 'space-bunny-free',
        modelChain: (process.env.APMIX_MODELS || 'deepseek-v4-flash-free,space-bunny-free')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        style: 'openai',
        maxTokens: Number(process.env.APMIX_MAX_TOKENS || 8192),
      },
      // AgentRouter — only Claude Opus 5 (what the API key has access to).
      // Used as coding sub-agent for build_website / fix_zip when key is set; Agnes stays primary chat.
      agentrouter: {
        label: 'AgentRouter (Claude Opus 5 coding sub-agent)',
        baseUrl: (process.env.AGENTROUTER_BASE_URL || 'https://agentrouter.org/v1').replace(/\/$/, ''),
        apiKeys: [process.env.AGENTROUTER_API_KEY, process.env.AGENT_ROUTER_API_KEY].filter(Boolean),
        model: process.env.AGENTROUTER_MODEL || 'claude-opus-5',
        fallbackModel: process.env.AGENTROUTER_FALLBACK_MODEL || 'claude-opus-5',
        modelChain: (process.env.AGENTROUTER_MODELS || 'claude-opus-5')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        style: 'agentrouter',
        maxTokens: Number(process.env.AGENTROUTER_MAX_TOKENS || 8192),
      },
    },
    // Provider used for long code generation (build_website, build_project, fix_zip).
    // Prefer agentrouter when key is set; otherwise apmix free models (deepseek-v4-flash-free).
    // Override with AI_CODING_PROVIDER=apmix|agentrouter|agnes
    codingProvider: process.env.AI_CODING_PROVIDER || (
      (process.env.APMIX_API_KEY || process.env.APMIX_KEY) ? 'apmix'
        : ((process.env.AGENTROUTER_API_KEY || process.env.AGENT_ROUTER_API_KEY) ? 'agentrouter' : 'agnes')
    ),
  },
  behavior: {
    // Group and DM replies require an explicit call; legacy always-on flags cannot override this.
    notifyOwnersOnChat: (process.env.NOTIFY_OWNERS_ON_CHAT || 'false') === 'true',
    groupRequireAddress: true,
    respondInGroupsAlways: false,
    botNames: [...new Set(
      [...list(process.env.BOT_NAMES), 'nick', 'nick ai']
        .map((n) => String(n || '').trim().toLowerCase())
        .filter(Boolean)
        // Never wake on generic AI words — only Nick's brand name (and BOT_NAMES overrides)
        .filter((n) => !['ai', 'bot', 'agent', 'agnes', 'gpt', 'chatgpt', 'claude', 'gemini'].includes(n))
    )].sort((a, b) => b.length - a.length),
  },
  economy: {
    currencyName: process.env.ECONOMY_CURRENCY_NAME || 'coins',
    dailyAmount: Number(process.env.ECONOMY_DAILY_AMOUNT || 200),
    workMin: Number(process.env.ECONOMY_WORK_MIN || 50),
    workMax: Number(process.env.ECONOMY_WORK_MAX || 300),
    workCooldownMin: Number(process.env.ECONOMY_WORK_COOLDOWN_MIN || 60),
    dailyCooldownHours: Number(process.env.ECONOMY_DAILY_COOLDOWN_HOURS || 24),
    robCooldownMin: Number(process.env.ECONOMY_ROB_COOLDOWN_MIN || 30),
    robSuccessChance: Number(process.env.ECONOMY_ROB_SUCCESS_CHANCE || 0.45),
    robMaxPercent: Number(process.env.ECONOMY_ROB_MAX_PERCENT || 0.25),
    robMinVictimBalance: Number(process.env.ECONOMY_ROB_MIN_VICTIM_BALANCE || 50),
    robFailFinePercent: Number(process.env.ECONOMY_ROB_FAIL_FINE_PERCENT || 0.15),
  },
  leveling: {
    xpPerMessage: Number(process.env.LEVELING_XP_PER_MESSAGE || 15),
    cooldownSeconds: Number(process.env.LEVELING_COOLDOWN_SECONDS || 45),
  },
  cardGame: {
    packCost: Number(process.env.CARDGAME_PACK_COST || 150),
    battleCooldownMin: Number(process.env.CARDGAME_BATTLE_COOLDOWN_MIN || 10),
    battleStake: Number(process.env.CARDGAME_BATTLE_STAKE || 50),
  },
  stickers: {
    replyToStickerChance: Number(process.env.STICKER_REPLY_CHANCE ?? 0.25), // chance to randomly react to an ordinary group sticker
    randomDropChance: Number(process.env.STICKER_RANDOM_DROP_CHANCE ?? 0.03), // chance per message to randomly drop a sticker
    minSavedForRandomDrop: Number(process.env.STICKER_MIN_FOR_RANDOM_DROP ?? 3),
  },
  github: {
    // Optional fallback token/repo; prefer GITHUB_TOKEN and keep credentials in deployment secrets, never tracked .env.
    // Without configured defaults, require a repository and token per request.
    defaultToken: process.env.GITHUB_TOKEN || process.env.GITHUB_DEFAULT_TOKEN || '',
    defaultRepoUrl: process.env.GITHUB_DEFAULT_REPO_URL || '',
  },
  integrations: {
    assemblyAiKey: process.env.ASSEMBLYAI_API_KEY || '',
    gofileToken: process.env.GOFILE_TOKEN || '',
    netlifyToken: process.env.NETLIFY_TOKEN || process.env.NETLIFY_AUTH_TOKEN || '',
    vercelToken: process.env.VERCEL_TOKEN || process.env.VERCEL_API_TOKEN || '',
    imgbbKey: process.env.IMGBB_API_KEY || '',
    screenshotOneKey: process.env.SCREENSHOTONE_ACCESS_KEY || '',
    groqKey: process.env.GROQ_API_KEY || '',
    geminiKey: process.env.GEMINIAPIKEY || process.env.GEMINI_API_KEY || '',
    malvryxKey: process.env.MALVRYX_API_KEY || '',
  },
  logLevel: process.env.LOG_LEVEL || 'info',
};

module.exports = config;
