const axios = require('axios');
const config = require('../config');
const logger = require('../logger');
const { getToolsFor, executeTool } = require('./tools');
const { Collection } = require('../db');


/** Keep only provider-supported message fields and repair empty content before requests. */
function sanitizeMessagesForApi(messages) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  for (const m of messages) {
    if (!m || !m.role) continue;
    let content = m.content;
    if (content == null) {
      content = m.tool_calls?.length ? '' : (m.role === 'system' ? '(system)' : '(empty)');
    }
    if (typeof content === 'string') {
      content = content.trim() || (m.tool_calls?.length ? '' : (m.role === 'tool' ? '{}' : '(empty)'));
    } else if (Array.isArray(content)) {
      const parts = content
        .map((b) => {
          if (!b) return null;
          if (typeof b === 'string') return b.trim() ? { type: 'text', text: b } : null;
          if (b.type === 'text') {
            const tx = String(b.text || '').trim();
            return tx ? { type: 'text', text: tx } : null;
          }
          if (b.type === 'image_url' && b.image_url) {
            const imageUrl = typeof b.image_url === 'string' ? { url: b.image_url } : b.image_url;
            if (!imageUrl.url) return null;
            return {
              type: 'image_url',
              image_url: {
                url: imageUrl.url,
                ...(imageUrl.detail ? { detail: imageUrl.detail } : {}),
              },
            };
          }
          if (b.type === 'input_audio' && b.input_audio) {
            return {
              type: 'input_audio',
              input_audio: { data: b.input_audio.data, format: b.input_audio.format },
            };
          }
          return null;
        })
        .filter(Boolean);
      if (!parts.length) {
        if (m.tool_calls?.length) {
          content = '';
        } else {
          content = '(empty)';
        }
      } else {
        content = parts;
      }
    }
    const safe = { role: m.role, content };
    if (typeof m.name === 'string' && ['system', 'developer', 'user', 'assistant', 'tool'].includes(m.role)) safe.name = m.name;
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      safe.tool_calls = m.tool_calls.map((call) => {
        const fn = call?.function;
        if (!fn?.name) return null;
        const args = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {});
        return {
          ...(typeof call.id === 'string' ? { id: call.id } : {}),
          type: 'function',
          function: { name: String(fn.name), arguments: args },
        };
      }).filter(Boolean);
    }
    if (m.role === 'tool' && typeof m.tool_call_id === 'string') safe.tool_call_id = m.tool_call_id;
    out.push(safe);
  }
  // Ensure at least one user message
  if (!out.some((m) => m.role === 'user')) {
    out.push({ role: 'user', content: 'Hi' });
  }
  return out;
}

function stripThinkTags(text) {
  if (!text) return text;
  let s = String(text);
  // Drop model chain-of-thought / reasoning leaks
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '');
  s = s.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
  s = s.replace(/```(?:thinking|reasoning)[\s\S]*?```/gi, '');
  // XML-style tool call leaks (common with some providers)
  s = s.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '');
  s = s.replace(/<tool_call>[\s\S]*$/gi, '');
  s = s.replace(/<function\s*=\s*[^>]+>[\s\S]*?<\/function>/gi, '');
  s = s.replace(/<function\s*=\s*[^>]+>[\s\S]*$/gi, '');
  s = s.replace(/<parameter\s*=\s*[^>]+>[\s\S]*?<\/parameter>/gi, '');
  s = s.replace(/<\|tool_call\|>[\s\S]*?<\|tool_call\|>/gi, '');
  s = s.replace(/<\|tool_calls_section_begin\|>[\s\S]*?<\|tool_calls_section_end\|>/gi, '');
  s = s.replace(/invoke\s+\w+\s+with\s+[\s\S]*?(?=\n\n|$)/gi, '');
  // Never leak raw tool-call / function JSON into chat
  s = s.replace(/\{\s*"type"\s*:\s*"function"\s*,\s*"name"\s*:\s*"[^"]+"\s*,\s*"parameters"\s*:\s*\{[\s\S]*?\}\s*\}/gi, '');
  s = s.replace(/\{\s*"type"\s*:\s*"function"\s*,[\s\S]*?"name"\s*:\s*"[^"]+"[\s\S]*?\}/gi, '');
  s = s.replace(/```(?:json|tool|function)?\s*\{\s*"type"\s*:\s*"function"[\s\S]*?```/gi, '');
  s = s.replace(/^\s*\{\s*"type"\s*:\s*"function"[\s\S]*\}\s*$/gim, '');
  s = s.replace(/\btool_call\b[\s\S]{0,40}\bfunction\s*=/gi, '');
  // Collapse leftover empty lines
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.replace(/^\s+|\s+$/g, '');
}

/** Final outbound guard — strips any residual tool/protocol text before WhatsApp. */
function sanitizeOutbound(text) {
  if (!text) return text;
  let s = stripThinkTags(text);
  if (/<tool_call>|<function\s*=|tool_calls_section|"type"\s*:\s*"function"/i.test(s)) {
    s = stripThinkTags(s);
  }
  // If almost only tool garbage remains, blank it so router can recover
  const cleaned = s.replace(/\s+/g, ' ').trim();
  if (!cleaned || cleaned.length < 2) return '';
  if (/^<\/?tool|^<function\s*=/i.test(cleaned)) return '';
  return s;
}

/** True if message content contains image/video/audio multimodal parts. */
function hasMultimodalContent(messages) {
  if (!Array.isArray(messages)) return false;
  for (const m of messages) {
    const c = m?.content;
    if (Array.isArray(c)) {
      if (c.some((b) => b && (b.type === 'image_url' || b.type === 'image' || b.type === 'video_url' || b.type === 'input_audio' || b.type === 'audio'))) return true;
    }
  }
  return false;
}

/** Strip multimodal blocks so text-only models can still answer. */
function stripMultimodal(messages) {
  return (messages || []).map((m) => {
    if (!m || !Array.isArray(m.content)) return m;
    const textParts = m.content
      .filter((b) => b && (typeof b === 'string' || b.type === 'text'))
      .map((b) => (typeof b === 'string' ? b : String(b.text || '')))
      .filter(Boolean);
    const note = m.content.some((b) => b && (b.type === 'image_url' || b.type === 'image'))
      ? '[User sent an image — describe/answer based on context if possible; vision is temporarily unavailable on this model.]'
      : '';
    return { ...m, content: [note, ...textParts].filter(Boolean).join('\n') || '(media)' };
  });
}

/** Providers known to support vision / multimodal natively. */
const VISION_PROVIDERS = new Set(['agnes', 'agnes-claude', 'openai', 'anthropic', 'agentrouter', 'grok', 'gemini', 'groq', 'stability']);

/** True when an assistant message has no usable text and no tool calls. */
function isEmptyAssistantMessage(msg) {
  if (!msg || typeof msg !== 'object') return true;
  const tools = msg.tool_calls;
  if (Array.isArray(tools) && tools.length) return false;
  const content = msg.content;
  if (content == null) return true;
  if (typeof content === 'string') return !content.trim();
  if (Array.isArray(content)) {
    return !content.some((b) => {
      if (!b) return false;
      if (typeof b === 'string') return !!b.trim();
      if (b.type === 'text' && String(b.text || '').trim()) return true;
      if (b.type === 'tool_use' || b.type === 'tool_calls') return true;
      return false;
    });
  }
  return !String(content).trim();
}

function emptyResponseError(providerName, model, detail) {
  const e = new Error(
    `Empty response from ${providerName || 'provider'}${model ? `/${model}` : ''}${detail ? `: ${detail}` : ''}`
  );
  e.code = 'EMPTY_RESPONSE';
  e.response = { status: 422, data: { error: { message: e.message, type: 'empty_response' } } };
  return e;
}

function userTextForRouting(value) {
  if (Array.isArray(value)) {
    return value.filter((part) => part?.type === 'text')
      .map((part) => String(part.text || ''))
      .join('\n')
      .slice(0, 6000);
  }
  return String(value || '').replace(/data:[^;]+;base64,[A-Za-z0-9+/=]+/g, '[media]').slice(0, 6000);
}

const TOOL_INTENT_RE = /\b(?:create|build|make|generate|design|write|edit|modify|update|fix|repair|debug|implement|refactor|deploy|publish|host|run|execute|install|download|upload|convert|analyze|inspect|read|open|search|browse|research|look\s+up|fetch|summarize|translate|transcribe|play|send|share|resize|compress|extract|scan|review|test|commit|push|calculate|find|list|show|get|check|retrieve|set|clear|delete|remove|switch|join|invite|weather|forecast|temperature|news|sports?|scores?|fixtures?|standings?|stock|crypto|price|remind|schedule|poll|vote|define|latest|current|github|repository|repo|server|vps|terminal|shell|browser|login|click|scroll|navigate|automate|meme|joke|location|view[ -]?once|ip|dns|model\s+status|switch\s+model|provider\s+status|qr|json|regex|port|docker|email|inbox|birthday|note|todo|memory|persona|reminder|url|link|translation|meaning|dictionary|encrypt|decrypt|encode|decode|format|hash|sql|jwt|uuid|timestamp|webhook|pem|custom\s+tool|tagall|kick|promote|demote|mute|warn|afk|role|roles|task\s+list|to\s*do)\b/i;

const TOOL_GROUPS = [
  { pattern: /\b(?:website|web\s*app|landing\s*page|web\s*site|site)\b/i, names: ['build_website', 'preview_website', 'deploy_netlify', 'deploy_vercel', 'host_project', 'host_status', 'task_plan', 'run_subagents', 'build_project', 'project_plan', 'project_ideas', 'host_file', 'preview_zip_site'] },
  { pattern: /\b(?:project|software|script|program|application|app)\b|(?<!qr\s)\bcode\b/i, names: ['build_project', 'project_plan', 'project_ideas', 'task_plan', 'run_subagents', 'write_file', 'read_file', 'list_files', 'search_files', 'code_review', 'project_scan', 'test_strategy', 'architecture_review', 'documentation_plan', 'next_project_tasks', 'send_file', 'workspace_zip'] },
  { pattern: /\b(?:file|folder|directory|document|pdf|zip|archive|spreadsheet|presentation|report)\b/i, names: ['write_file', 'read_file', 'list_files', 'search_files', 'generate_document', 'send_file', 'send_any_file', 'host_file', 'file_send_from_url', 'analyze_zip', 'read_zip_file', 'list_zip_files', 'fix_zip', 'pack_media_zip', 'workspace_zip', 'zip_encrypt', 'zip_decrypt', 'task_plan'] },
  { pattern: /\b(?:navigate|browse|explore|open)\b.{0,60}\b(?:project|workspace|files?|folders?|directories|repos?|repository|repositories)\b/i, names: ['read_file', 'list_files', 'search_files', 'write_file'] },
  { pattern: /\b(?:github|git|repo|repository)\b/i, names: ['repo_work', 'repo_memory', 'github_connect', 'github_disconnect', 'github_connection_status', 'github_list_repos', 'github_get_repo', 'github_search_repos', 'github_read_file', 'github_upsert_file', 'github_create_repo', 'github_add_collaborator', 'github_create_issue', 'github_list_issues', 'git_status', 'git_commit_push', 'push_to_github', 'task_plan'] },
  { pattern: /\b(?:browser|webpage|web\s+page|click|scroll|log\s*in|login|sign\s*up|automate|screen\s*record)\b|\b(?:navigate|browse)\b(?=[^.!?]{0,80}\b(?:https?:\/\/|www\.|website|webpage|web\s+page|browser|site|url)\b)/i, names: ['browser_navigate', 'browser_click', 'browser_scroll', 'browser_type', 'web_login', 'browser_login', 'browser_signup', 'web_automate', 'browser_screen_record', 'browser_screenshot', 'browser_diagnose', 'browser_extract', 'browser_execute_script', 'browser_cookies', 'browser_pdf'] },
  { pattern: /\b(?:sports?|football|soccer|basketball|cricket|rugby|tennis|hockey|baseball|golf|formula\s*1|f1|nba|nfl|mlb|nhl|premier\s+league|champions\s+league)\b|\b(?:live|current|latest|today(?:'s)?)\s+(?:scores?|fixtures?|standings?|results?)\b|\b(?:scores?|fixtures?|standings?)\s+(?:for|in|today|now)\b/i, names: ['web_search', 'search', 'web_search_news'] },
  { pattern: /\b(?:search|research|look\s+up|latest|current|news|headline|source|url|link|summarize)\b|\bbrowse\b(?![^.!?]{0,80}\b(?:project|files?|folders?|directories|workspace|repos?|repository|repositories)\b)/i, names: ['web_search', 'search', 'news', 'web_search_news', 'google_search_scraper', 'fetch_url', 'fetch_page_source', 'scrape_webpage', 'scrape_url', 'summarize_url', 'browser_navigate', 'browser_extract', 'youtube_search', 'youtube_scrape_search', 'pinterest_search'] },
  { pattern: /\b(?:image|photo|picture|logo|illustration|sticker|screenshot|graphic|poster|card)\b/i, names: ['generate_image', 'image_generator', 'analyze_image', 'design_extract', 'resize_image', 'make_sticker', 'send_sticker', 'send_image', 'host_image_link', 'canvas_rank_card', 'canvas_quote_card', 'canvas_ship_card', 'canvas_leaderboard_card', 'canvas_monster_card', 'canvas_profile_card', 'canvas_battle_card'] },
  { pattern: /\b(?:video|audio|voice\s*note|song|music|podcast|lyrics|mp3|telegram\s+media|pinterest\s+media)\b/i, names: ['generate_video', 'download_media', 'send_video_file', 'video_to_mp3', 'sticker_to_video', 'convert_audio', 'send_voice_note', 'play_song', 'search_music', 'get_lyrics', 'search_download_video', 'download_video_url', 'ytmp3', 'telegram_media', 'telegram_public_media', 'pinterest_media', 'spotify_search'] },
  { pattern: /\b(?:server|vps|terminal|shell|command\s+line|logs?|health\s+check|install|npm|package|dependency|api\s+test|port|docker|mcp)\b/i, names: ['server_info', 'read_logs', 'mcp_status', 'mcp_reconnect', 'server_exec', 'vps_service', 'linux_shell', 'run_command', 'install_dependency', 'npm_search', 'npm_package', 'health_status', 'port_scan', 'dev_docker_compose', 'api_test', 'http_api', 'dev_http', 'dev_openapi_stub'] },
  { pattern: /\b(?:security|vulnerabilit\w*|dependency\s+audit|security\s+audit|threat\s+model)\b/i, names: ['security_audit', 'dependency_audit', 'code_review', 'project_scan', 'test_strategy', 'architecture_review', 'port_scan'] },
  { pattern: /\b(?:json|minify)\b/i, names: ['dev_json', 'json_format', 'json_minify'] },
  { pattern: /\b(?:qr\s*code|qr)\b/i, names: ['generate_qr'] },
  { pattern: /\b(?:base64|encode|decode)\b/i, names: ['dev_base64'] },
  { pattern: /\bjwt\b/i, names: ['dev_jwt_decode'] },
  { pattern: /\buuid\b/i, names: ['dev_uuid'] },
  { pattern: /\b(?:regex|regular\s+expression)\b/i, names: ['dev_regex'] },
  { pattern: /\b(?:timestamp|date\s*time)\b/i, names: ['dev_timestamp', 'check_date_time'] },
  { pattern: /\b(?:dotenv|env\s+file|environment\s+file)\b/i, names: ['dev_dotenv_lint'] },
  { pattern: /\bsql\b/i, names: ['dev_sql_format', 'database_design'] },
  { pattern: /\b(?:pem|certificate)\b/i, names: ['dev_pem_inspect'] },
  { pattern: /\bwebhook\b/i, names: ['dev_webhook_sign', 'http_api', 'dev_http'] },
  { pattern: /\b(?:openapi|api\s+schema)\b/i, names: ['dev_openapi_stub', 'dev_http', 'api_test', 'http_api'] },
  { pattern: /\b(?:url\s+parser|parse\s+url)\b/i, names: ['dev_url_parse', 'fetch_url'] },
  { pattern: /\b(?:weather|forecast|temperature)\b/i, names: ['get_weather', 'weather'] },
  { pattern: /\b(?:calculate|calculator|math|equation)\b/i, names: ['calculate', 'calculator'] },
  { pattern: /\b(?:translate|translation)\b/i, names: ['translate_text'] },
  { pattern: /\b(?:reminder|remind|schedule|timer|cron|proactive)\b/i, names: ['set_reminder', 'list_reminders', 'cancel_reminder', 'recurring_reminder', 'cron_add', 'cron_list', 'cron_remove', 'proactive_add', 'proactive_list', 'proactive_remove'] },
  { pattern: /\b(?:poll|vote|voting)\b/i, names: ['send_poll', 'create_poll', 'vote_on_poll'] },
  { pattern: /\b(?:stock|crypto|bitcoin|market|price)\b/i, names: ['stock_price', 'crypto_price'] },
  { pattern: /\b(?:definition|define|meaning|dictionary)\b/i, names: ['define_word'] },
  { pattern: /\b(?:group|member|members|tagall|kick|promote|demote|mute|warn|afk|role|roles|join\s+group)\b/i, names: ['group_members_list', 'manage_roles', 'list_roles', 'send_poll', 'create_poll', 'vote_on_poll', 'send_dm', 'join_group', 'set_afk', 'clear_afk', 'call_settings', 'delete_message', 'react_to_message'] },
  { pattern: /\b(?:note|notes|remember|memory|todo|to\s+do|task\s+list)\b/i, names: ['note_save', 'note_list', 'note_delete', 'perm_memory_add', 'perm_memory_search', 'perm_memory_list', 'perm_memory_remove', 'todo_add', 'todo_list', 'todo_complete', 'todo_delete', 'todo_clear', 'next_project_tasks', 'task_plan'] },
  { pattern: /\b(?:email|e\s*mail|inbox|temporary\s+mail|temp\s+mail)\b/i, names: ['temp_mail_create', 'temp_mail_inbox'] },
  { pattern: /\b(?:meme|joke|funny|roast|random\s+fact|debate|birthday|persona|profile\s+card)\b/i, names: ['fetch_meme', 'fetch_funny_tweet', 'fetch_debate_topic', 'fetch_tiktok_comedy', 'fetch_comedy', 'random_fact', 'roast', 'ship', 'birthday_set', 'birthday_get', 'birthday_remove', 'persona_list', 'persona_set', 'style_text', 'canvas_profile_card'] },
  { pattern: /\b(?:view[ -]?once|viewonce)\b/i, names: ['unlock_view_once'] },
  { pattern: /\b(?:ip\s+address|dns|domain|whois|network\s+lookup|scan\s+ports)\b/i, names: ['ip_lookup', 'dns_lookup', 'port_scan'] },
  { pattern: /\b(?:location|map|directions|share\s+location)\b/i, names: ['send_location'] },
  { pattern: /\b(?:model\s+status|switch\s+model|ai\s+provider|provider\s+status|capabilities)\b/i, names: ['model_status', 'switch_model', 'agent_capabilities', 'api_test'] },
  { pattern: /\b(?:custom\s+tool|create\s+tool|list\s+tools|delete\s+tool)\b/i, names: ['create_tool', 'execute_custom_tool', 'list_custom_tools', 'delete_custom_tool', 'list_runtime_tools'] },
];

const TOOL_QUERY_STOP = new Set(['please', 'could', 'would', 'can', 'you', 'me', 'my', 'the', 'a', 'an', 'to', 'for', 'with', 'on', 'at', 'as', 'and', 'or', 'but', 'it', 'this', 'that', 'what', 'how', 'i', 'we', 'help', 'need', 'want', 'create', 'build', 'make', 'generate', 'design', 'write', 'edit', 'modify', 'update', 'fix', 'repair', 'debug', 'implement', 'refactor', 'deploy', 'publish', 'host', 'run', 'execute', 'install', 'download', 'upload', 'convert', 'analyze', 'inspect', 'read', 'open', 'search', 'browse', 'research', 'fetch', 'summarize', 'translate', 'transcribe', 'play', 'send', 'share', 'resize', 'compress', 'extract', 'scan', 'review', 'test', 'commit', 'push', 'calculate', 'join', 'login', 'click', 'scroll', 'navigate', 'automate', 'find', 'list', 'show', 'get', 'check', 'retrieve', 'set', 'clear', 'delete', 'remove', 'switch', 'invite']);

function selectToolsForRequest(allTools, requestText) {
  const text = String(requestText || '').toLowerCase();
  if (!TOOL_INTENT_RE.test(text)) return [];

  const wanted = new Set();
  for (const group of TOOL_GROUPS) {
    if (group.pattern.test(text)) group.names.forEach((name) => wanted.add(name));
  }
  const normalizedText = text.replace(/[\s-]+/g, '_');
  for (const tool of allTools || []) {
    const name = String(tool?.function?.name || '').toLowerCase();
    if (name && (normalizedText.includes(name) || text.includes(name.replace(/_/g, ' ')))) wanted.add(name);
  }

  if (!wanted.size) {
    const queryTokens = new Set((text.match(/[a-z0-9]{2,}/g) || []).filter((token) => !TOOL_QUERY_STOP.has(token)));
    const ranked = (allTools || []).map((tool) => {
      const name = String(tool?.function?.name || '').toLowerCase();
      const parts = name.split(/[^a-z0-9]+/).filter(Boolean);
      const score = parts.reduce((total, part) => total + (queryTokens.has(part) ? (part.length > 3 ? 2 : 1) : 0), 0);
      return { name, score };
    }).filter((item) => item.name && item.score > 0).sort((a, b) => b.score - a.score).slice(0, 8);
    ranked.forEach((item) => wanted.add(item.name));
  }

  const selected = [];
  const seen = new Set();
  let schemaChars = 0;
  for (const tool of allTools || []) {
    const name = String(tool?.function?.name || '').toLowerCase();
    if (!wanted.has(name) || seen.has(name)) continue;
    const size = JSON.stringify(tool).length;
    if (selected.length >= 18 || schemaChars + size > 18000) continue;
    selected.push(tool);
    seen.add(name);
    schemaChars += size;
  }
  return selected;
}

// Agnes Video's result-polling endpoint lives at the API root (…/agnesapi), not under
// /v1 like everything else — so we need the base URL both with and without /v1.
const AGNES_ROOT = config.ai.baseUrl.replace(/\/v1$/, '');

// Persisted owner choice of active chat provider — survives restarts. Falls back to
// config.ai.defaultProvider if never set or if the stored name no longer exists.
const providerOverride = new Collection('ai_provider', {});

function providerHasKey(name) {
  const p = config.ai.providers[name];
  if (!p) return false;
  if (p.local) return true;
  if (p.style === 'qwen-free') return true;
  return Array.isArray(p.apiKeys) && p.apiKeys.some((k) => k && String(k).trim());
}

function providersWithKeys() {
  // Use Nick AI's configured chat default first, followed by configured providers.
  const chain = Array.isArray(config.ai.providerChain) ? config.ai.providerChain : [];
  const preferred = [
    config.ai.defaultProvider || 'groq',
    ...chain,
    'groq', 'agnes', 'agnes-claude',
  ];
  const seen = new Set();
  const ordered = [];
  for (const n of preferred) {
    if (!n || seen.has(n) || !config.ai.providers[n]) continue;
    seen.add(n);
    if (providerHasKey(n)) ordered.push(n);
  }
  for (const n of Object.keys(config.ai.providers)) {
    if (seen.has(n)) continue;
    if (providerHasKey(n)) ordered.push(n);
  }
  return ordered;
}

/** Coding / sub-agent backends only (not main chat). */
function codingProvidersWithKeys() {
  const chain = Array.isArray(config.ai.codingChain) ? config.ai.codingChain : [];
  const preferred = [
    config.ai.codingProvider,
    ...chain,
    'apmix', 'agentrouter', 'nvidia', 'groq', 'gemini', 'agnes-claude', 'agnes',
  ];
  const ban = new Set(['openai', 'anthropic', 'grok', 'xai', 'gpt', 'stability']);
  const seen = new Set();
  const ordered = [];
  for (const n of preferred) {
    if (!n || seen.has(n) || ban.has(n) || !config.ai.providers[n]) continue;
    seen.add(n);
    if (providerHasKey(n)) ordered.push(n);
  }
  for (const n of Object.keys(config.ai.providers || {})) {
    if (seen.has(n) || ban.has(n)) continue;
    if (providerHasKey(n)) ordered.push(n);
  }
  return ordered;
}

function getActiveProviderName() {
  const ban = new Set(['openai', 'anthropic', 'grok', 'xai', 'gpt', 'stability']);
  const stored = providerOverride.get('active', null);
  // Owner may switch at runtime, but banned providers are ignored.
  if (stored && !ban.has(stored) && config.ai.providers[stored] && providerHasKey(stored)) return stored;
  if (stored && (ban.has(stored) || (config.ai.providers[stored] && !providerHasKey(stored)))) {
    logger.warn({ stored }, 'stored provider unusable — using configured default');
  }
  const def = config.ai.defaultProvider || 'groq';
  if (def && !ban.has(def) && config.ai.providers[def] && providerHasKey(def)) return def;
  const withKeys = providersWithKeys().filter((n) => !ban.has(n));
  if (withKeys.length) return withKeys[0];
  return config.ai.providers[def] ? def : Object.keys(config.ai.providers)[0];
}

// Accept provider names, vendor names, aliases, and model names. This keeps
// `model deepseek`, `switch to DeepSeek`, `model gpt`, etc. working even though
// the actual provider key may be `nvidia` or `openai`.
const PROVIDER_ALIASES = {
  deepseek: 'nvidia',
  'deepseek-ai': 'nvidia',
  nim: 'nvidia',
  nvidia: 'nvidia',
  ollama: 'ollama',
  local: 'ollama',
  gpt: 'gpt',
  chatgpt: 'gpt',
  'gpt-android': 'gpt',
  'gpt5': 'gpt',
  'gpt-5': 'gpt',
  openai: 'agnes', // removed — map to main brain
  'gpt-4o': 'openai',
  'gpt-4o-mini': 'openai',
  claude: 'agnes-claude',
  anthropic: 'agnes', // removed — map to main brain
  sonnet: 'agnes-claude',
  haiku: 'agnes-claude',
  'claude-code': 'agnes-claude',
  agnes: 'agnes',
  'agnes-ai': 'agnes',
  'agnes-2.5-flash': 'agnes',
  'agnes-2.0-flash': 'agnes',
  'deepseek-v4-flash': 'nvidia',
  'deepseek-ai/deepseek-v4-flash': 'nvidia',
  'claude-sonnet': 'agnes-claude',
  'claude-sonnet-4-6': 'agnes-claude',
  groq: 'groq',
  'llama-3.3': 'groq',
  'llama-3.1': 'groq',
  grok: 'agnes', // xai/grok removed
  xai: 'agnes',
  'x-ai': 'agnes',
  'grok-2': 'agnes',
  'grok-2-latest': 'agnes',
  stability: 'stability',
  gemini: 'gemini',
  google: 'gemini',
  'gemini-2': 'gemini',
  'gemini-2.0-flash': 'gemini',
  'gemini-1.5-flash': 'gemini',
  agentrouter: 'agentrouter',
  'agent-router': 'agentrouter',
  'claude-opus-5': 'agentrouter',
  opus: 'agentrouter',
  opus5: 'agentrouter',
  'opus-5': 'agentrouter',
  apmix: 'apmix',
  'apmix.ai': 'apmix',
  deepseek: 'apmix',
  'deepseek-v4': 'apmix',
  'deepseek-v4-flash': 'apmix',
  'deepseek-v4-flash-free': 'apmix',
  'space-bunny': 'apmix',
  'space-bunny-free': 'apmix',
};

function resolveProviderName(input) {
  const raw = String(input || '').trim().toLowerCase().replace(/^(?:switch|change)\s+(?:to\s+)?/, '').replace(/^(?:model|provider)\s+/, '').trim();
  if (!raw) return null;
  if (config.ai.providers[raw]) return raw;
  if (PROVIDER_ALIASES[raw]) return PROVIDER_ALIASES[raw];

  for (const [name, provider] of Object.entries(config.ai.providers)) {
    const model = String(provider.model || '').toLowerCase();
    const label = String(provider.label || '').toLowerCase();
    if (model === raw || model.includes(raw) || label.includes(raw)) return name;
  }
  return null;
}

function setActiveProvider(input) {
  const name = resolveProviderName(input);
  if (!name) {
    const options = Object.entries(config.ai.providers).map(([key, p]) =>
      `${key} (${p.model})`).join(', ');
    return { ok: false, error: `Unknown provider/model "${input}". Try: ${options}` };
  }
  providerOverride.set('active', name);
  const provider = config.ai.providers[name];
  return {
    ok: true,
    provider: name,
    model: provider.model,
    hasKey: !!(provider.apiKeys && provider.apiKeys.length),
    warning: !(provider.apiKeys && provider.apiKeys.length)
      ? `No API key is configured for ${name}. Set the provider's API key before sending AI requests.`
      : undefined,
  };
}

function getActiveProvider() {
  return { name: getActiveProviderName(), ...config.ai.providers[getActiveProviderName()] };
}

// One-shot startup visibility: which providers actually have keys.
try {
  if (!global.__nickAiProvidersLogged) {
    global.__nickAiProvidersLogged = true;
    const active = getActiveProviderName();
    const keys = providersWithKeys();
    logger.info({
      active,
      mainBrain: config.ai.defaultProvider || 'groq',
      chatWithKeys: keys,
      codingWithKeys: codingProvidersWithKeys(),
      default: config.ai.defaultProvider,
      chatChain: config.ai.providerChain,
      codingChain: config.ai.codingChain,
      coding: config.ai.codingProvider,
    }, 'AI providers ready');
    if (!keys.length) {
      logger.error('NO AI API KEYS configured — set GROQ_API_KEY (Nick AI default) or another configured provider key.');
    }
  }
} catch (e) {
  logger.warn({ err: e.message }, 'provider bootstrap log failed');
}

function listProviders() {
  return Object.entries(config.ai.providers).map(([name, p]) => ({
    name,
    label: p.label,
    model: p.model,
    // gpt/ollama are usable without a real vendor key
    hasKey: !!(p.apiKeys && p.apiKeys.length) || !!p.local || name === 'gpt',
    local: !!p.local || name === 'gpt',
  }));
}

class AIClient {
  constructor() {
    this.keyIdx = 0;
  }

  // Round-robin across keys (per-provider). Agnes #1 → #2 → #3 → #1 on each call / 429.
  nextKey(provider) {
    const keys = (provider.apiKeys || []).filter((k) => k && String(k).trim());
    if (!keys.length) return '';
    if (!this._keyIdxByProvider) this._keyIdxByProvider = Object.create(null);
    const pool = (provider.name === 'agnes' || provider.name === 'agnes-claude') ? 'agnes' : (provider.name || 'default');
    const idx = this._keyIdxByProvider[pool] || 0;
    const k = keys[idx % keys.length];
    this._keyIdxByProvider[pool] = idx + 1;
    this.keyIdx = (this.keyIdx || 0) + 1;
    if (keys.length > 1) {
      logger.info({ provider: pool, slot: (idx % keys.length) + 1, of: keys.length }, 'rotating API key');
    }
    return k;
  }

  _markKeyLimited(provider, key) {
    if (!key) return;
    if (!this._keyCooldown) this._keyCooldown = Object.create(null);
    const pool = (provider?.name === 'agnes' || provider?.name === 'agnes-claude') ? 'agnes' : (provider?.name || 'default');
    this._keyCooldown[`${pool}:${key.slice(0, 12)}`] = Date.now() + Number(process.env.AI_KEY_COOLDOWN_MS || 60000);
  }

  nextKeyFresh(provider) {
    const keys = (provider.apiKeys || []).filter((k) => k && String(k).trim());
    if (!keys.length) return '';
    if (!this._keyCooldown) this._keyCooldown = Object.create(null);
    const pool = (provider.name === 'agnes' || provider.name === 'agnes-claude') ? 'agnes' : (provider.name || 'default');
    const now = Date.now();
    for (let i = 0; i < keys.length; i++) {
      const k = this.nextKey(provider);
      const until = this._keyCooldown[`${pool}:${k.slice(0, 12)}`] || 0;
      if (until <= now) return k;
    }
    return this.nextKey(provider);
  }

  _http(provider, key, timeoutMs) {
    // Builds / long generations need far more than 60s; default 5 minutes (override via AI_HTTP_TIMEOUT_MS)
    const timeout = Math.min(
      Math.max(Number(timeoutMs ?? config.ai.httpTimeoutMs ?? process.env.AI_HTTP_TIMEOUT_MS ?? 300000), 30000),
      600000
    );
    if (provider.style === 'anthropic') {
      return axios.create({
        baseURL: provider.baseUrl,
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        timeout,
      });
    }
    // AgentRouter WAF expects the official claude-cli / Stainless fingerprint.
    // Without these headers the request is blocked even with a valid Bearer key.
    if (provider.style === 'agentrouter') {
      return axios.create({
        baseURL: provider.baseUrl,
        headers: {
          Authorization: `Bearer ${key}`,
          'User-Agent': 'claude-cli/2.1.158 (external, sdk-cli)',
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
          'x-app': 'cli',
          'X-Stainless-Lang': 'js',
          'X-Stainless-Package-Version': '0.94.0',
          'X-Stainless-Runtime': 'node',
          'X-Stainless-Runtime-Version': process.version || 'v24.3.0',
          'Content-Type': 'application/json',
        },
        timeout,
      });
    }
    return axios.create({
      baseURL: provider.baseUrl,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      timeout,
    });
  }

  /** Converts OpenAI-shaped {role, content, tool_calls} messages to Anthropic's Messages
   *  API shape and back. Anthropic uses a top-level `system` field (not a system message
   *  in the array) and `tools`/`tool_use`/`tool_result` blocks instead of `tool_calls`. */
  async _anthropicCompletion(provider, model, messages, tools, key, signal) {
    const http = this._http(provider, key);
    // Anthropic/AgentRouter require string or content-block arrays — never null/undefined/objects.
    const asText = (c) => {
      if (c == null) return '';
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) {
        return c.map((b) => (typeof b === 'string' ? b : b?.text || b?.content || '')).filter(Boolean).join('\n');
      }
      return String(c);
    };
    const system = asText(messages.find((m) => m.role === 'system')?.content) || undefined;
    const rest = messages.filter((m) => m.role !== 'system').map((m) => {
      if (m.role === 'tool') {
        return {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: asText(m.content) }],
        };
      }
      if (m.tool_calls) {
        const blocks = [];
        const text = asText(m.content);
        if (text) blocks.push({ type: 'text', text });
        for (const c of m.tool_calls) {
          let input = {};
          try { input = JSON.parse(c.function?.arguments || '{}'); } catch { input = {}; }
          blocks.push({ type: 'tool_use', id: c.id, name: c.function?.name || 'unknown', input });
        }
        return { role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '' }] };
      }
      return { role: m.role === 'assistant' ? 'assistant' : 'user', content: asText(m.content) };
    }).filter((m) => m.content !== undefined && m.content !== null);
    const anthTools = (tools || [])
      .filter((t) => t?.function?.name)
      .map((t) => ({
        name: t.function.name,
        description: t.function.description || '',
        input_schema: t.function.parameters || { type: 'object', properties: {} },
      }));
    const maxTokens = Math.min(Math.max(Number(provider.maxTokens) || 4096, 256), 32000);
    const postBody = (useTools) => ({
      model,
      max_tokens: maxTokens,
      system,
      messages: rest,
      tools: useTools && anthTools.length ? anthTools : undefined,
    });
    let data;
    try {
      ({ data } = await http.post('/messages', postBody(true), { signal }));
    } catch (err) {
      const status = err.response?.status;
      const body = err.response?.data;
      const detail =
        typeof body === 'string'
          ? body.slice(0, 500)
          : body?.error?.message || body?.message || JSON.stringify(body || {}).slice(0, 500);
      if (status && detail) {
        err.message = `Request failed with status code ${status}: ${detail}`;
      }
      // AgentRouter / Anthropic often 400 on bad tools schema — retry without tools so coding/chat still works.
      if (status === 400 && anthTools.length) {
        logger.warn({ provider: provider.name, model, detail }, '400 with tools (anthropic/agentrouter) — retrying without tools');
        try {
          ({ data } = await http.post('/messages', postBody(false), { signal }));
        } catch (err2) {
          const d2 = err2.response?.data;
          const detail2 =
            typeof d2 === 'string'
              ? d2.slice(0, 500)
              : d2?.error?.message || d2?.message || JSON.stringify(d2 || {}).slice(0, 500);
          if (err2.response?.status && detail2) {
            err2.message = `Request failed with status code ${err2.response.status}: ${detail2}`;
          }
          throw err2;
        }
      } else {
        throw err;
      }
    }
    if (data?.error && !(data.content || []).length) {
      const errMsg = data.error.message || data.message || 'provider error';
      throw emptyResponseError(provider.name, model, errMsg);
    }
    const textBlock = (data.content || []).find((b) => b.type === 'text');
    const toolBlocks = (data.content || []).filter((b) => b.type === 'tool_use');
    const message = {
      role: 'assistant',
      content: textBlock?.text || '',
      tool_calls: toolBlocks.length
        ? toolBlocks.map((b) => ({ id: b.id, function: { name: b.name, arguments: JSON.stringify(b.input) } }))
        : undefined,
    };
    if (isEmptyAssistantMessage(message)) {
      logger.warn({ provider: provider.name, model, style: provider.style }, 'empty Anthropic-style response');
      throw emptyResponseError(provider.name, model, data?.stop_reason || 'blank content');
    }
    return message;
  }

  async _completionWithModel(provider, model, messages, tools, key, signal) {
    if (provider.style === 'qwen-free') {
      throw new Error('Qwen provider has been permanently removed. Use Agnes (default) or another configured provider.');
    }
    if (provider.style === 'gpt-android') {
      // Free GPT via ChatGPT Android anonymous API — text only, no tools
      const gptAndroid = require('../features').gptAndroid;
      // Strip tools: this path cannot execute tools; model just chats
      const textMessages = (messages || []).map((m) => {
        if (!m) return m;
        if (Array.isArray(m.content)) {
          const text = m.content
            .filter((b) => b && (typeof b === 'string' || b.type === 'text'))
            .map((b) => (typeof b === 'string' ? b : String(b.text || '')))
            .join('\n');
          return { role: m.role, content: text || '(media omitted)' };
        }
        return { role: m.role, content: typeof m.content === 'string' ? m.content : String(m.content || '') };
      });
      const msg = await gptAndroid.complete(textMessages);
      if (!msg || !String(msg.content || '').trim()) {
        throw emptyResponseError(provider.name, model, 'gpt-android blank');
      }
      return { role: 'assistant', content: msg.content };
    }
    if (provider.style === 'anthropic' || provider.style === 'agentrouter') {
      return this._anthropicCompletion(provider, model, messages, tools, key, signal);
    }
    const http = this._http(provider, key || this.nextKey(provider));
    // Many models (incl. some Agnes routes / local) only allow a single tool call per turn.
    // Force parallel_tool_calls off so we never hit "This model only supports single tool-calls".
    const safeMessages = sanitizeMessagesForApi(messages);
    let safeTools = Array.isArray(tools) ? tools : undefined;
    // Some providers/models (e.g. Groq) enforce a max tools count (commonly 128).
    // Cap proactively to avoid 400 errors and fallback churn.
    if (safeTools && safeTools.length > 128) {
      logger.warn({ provider: provider.name, model, tools: safeTools.length, cap: 128 }, 'too many tools — capping for provider request');
      safeTools = safeTools.slice(0, 128);
    }
    const payload = {
      model,
      messages: safeMessages,
      tools: safeTools && safeTools.length ? safeTools : undefined,
      tool_choice: safeTools && safeTools.length ? 'auto' : undefined,
      parallel_tool_calls: (process.env.AI_PARALLEL_TOOLS || 'false') === 'true',
    };
    let data;
    try {
      ({ data } = await http.post('/chat/completions', payload, { signal }));
    } catch (err) {
      const status = err.response?.status;
      const body = err.response?.data;
      const detail =
        typeof body === 'string'
          ? body.slice(0, 500)
          : body?.error?.message || body?.message || JSON.stringify(body || {}).slice(0, 500);
      // Enrich so owners see the real Agnes/OpenAI validation reason instead of bare "status code 400"
      if (status && detail) {
        err.message = `Request failed with status code ${status}: ${detail}`;
      }
      const isSingleToolErr = /single tool.?call|only supports single|parallel.?tool/i.test(detail || err.message || '');
      const isMultimodalErr = /multimodal|enable-multimodal|vision|image.*not.*(support|enable)/i.test(detail || err.message || '');

      // Multimodal not enabled on this model → strip images and retry once (text-only).
      if (isMultimodalErr && hasMultimodalContent(messages)) {
        logger.warn({ provider: provider.name, model, detail }, 'multimodal rejected — retrying text-only');
        try {
          const textOnly = stripMultimodal(messages);
          ({ data } = await http.post('/chat/completions', { ...payload, messages: sanitizeMessagesForApi(textOnly) }, { signal }));
        } catch (err2) {
          throw err2;
        }
      }
      // Single-tool-call models: retry with only the first tool definition + no parallel flag issues.
      else if ((status === 400 || isSingleToolErr) && tools && tools.length) {
        logger.warn({ provider: provider.name, model, detail }, '400 / single-tool error — retrying without tools');
        try {
          ({ data } = await http.post('/chat/completions', { model, messages: sanitizeMessagesForApi(messages), parallel_tool_calls: false }, { signal }));
        } catch (err2) {
          const d2 = err2.response?.data;
          const detail2 =
            typeof d2 === 'string'
              ? d2.slice(0, 500)
              : d2?.error?.message || d2?.message || JSON.stringify(d2 || {}).slice(0, 500);
          if (err2.response?.status && detail2) {
            err2.message = `Request failed with status code ${err2.response.status}: ${detail2}`;
          }
          throw err2;
        }
      } else if (status === 400 && tools && tools.length) {
        logger.warn({ provider: provider.name, model, detail }, '400 with tools — retrying without tools');
        try {
          ({ data } = await http.post('/chat/completions', { model, messages: safeMessages }, { signal }));
        } catch (err2) {
          const d2 = err2.response?.data;
          const detail2 =
            typeof d2 === 'string'
              ? d2.slice(0, 500)
              : d2?.error?.message || d2?.message || JSON.stringify(d2 || {}).slice(0, 500);
          if (err2.response?.status && detail2) {
            err2.message = `Request failed with status code ${err2.response.status}: ${detail2}`;
          }
          throw err2;
        }
      } else {
        throw err;
      }
    }
    const choice = data?.choices?.[0];
    const message = choice?.message;
    if (!message) {
      const detail = data?.error?.message || (Array.isArray(data?.choices) && !data.choices.length ? 'no choices' : 'missing message');
      logger.warn({ provider: provider.name, model, detail, finish: choice?.finish_reason }, 'empty OpenAI-style response');
      throw emptyResponseError(provider.name, model, detail);
    }
    if (isEmptyAssistantMessage(message)) {
      logger.warn({ provider: provider.name, model, finish: choice?.finish_reason }, 'empty assistant content');
      throw emptyResponseError(provider.name, model, choice?.finish_reason || 'blank content');
    }
    return message;
  }

  /** Tries the configured model first; if it 400/404/422s (e.g. gray-release model not
   *  enabled on this key yet), silently retries once with the stable fallback model.
   *  Resolves the active provider (owner-switchable via "model <name>") fresh on every
   *  call so a runtime switch takes effect immediately, no restart needed. */
  async _completion(messages, tools, signal) {
    let provider = getActiveProvider();
    // Groq's normal chat default is text-only. Image turns use the separately
    // configured vision model without changing the model used for ordinary chat.
    if (hasMultimodalContent(messages) && provider.name === 'groq' && provider.visionModel) {
      provider = { ...provider, model: provider.visionModel };
    }
    // For multimodal turns, prefer a provider known to support vision when the
    // selected provider does not, avoiding unsupported multimodal requests.
    if (hasMultimodalContent(messages) && !VISION_PROVIDERS.has(provider.name) && config.ai.providers.agnes) {
      const agnes = { name: 'agnes', ...config.ai.providers.agnes };
      if ((agnes.apiKeys || []).length) {
        logger.info({ from: provider.name }, 'vision request — routing to Agnes (main brain)');
        provider = agnes;
      }
    }
    const keyCount = Math.max((provider.apiKeys || []).length, 1);

    // Local providers don't need a real API key. `local` is only a harmless
    // placeholder so the existing OpenAI-compatible transport can be reused.
    if (!(provider.apiKeys || []).length && !provider.local && provider.style !== 'qwen-free') {
      // Auto-rescue: switch to any keyed provider (coding backends included) instead of hard-failing.
      const rescue = [...providersWithKeys(), ...codingProvidersWithKeys()].find((n) => n && n !== provider.name);
      if (rescue && config.ai.providers[rescue]) {
        logger.warn({ from: provider.name, to: rescue }, 'active provider has no key — rescuing to keyed provider');
        provider = { name: rescue, ...config.ai.providers[rescue] };
      } else {
        throw new Error(`No API key configured for provider "${provider.name}". Add that provider's key to .env (GROQ_API_KEY is Nick AI's default) and restart.`);
      }
    }

    const isAbort = (e) => e?.name === 'CanceledError' || e?.code === 'ERR_CANCELED' || !!signal?.aborted;

    const attempts = Math.max(keyCount * 3, 3); // enough passes to rotate all Agnes keys on 429
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      if (signal?.aborted) { const e = new Error('Aborted'); e.name = 'CanceledError'; throw e; }
      const key = provider.local ? 'local' : this.nextKeyFresh(provider);
      try {
        return await this._completionWithModel(provider, provider.model, messages, tools, key, signal);
      } catch (e) {
        lastErr = e;
        // A cancellation is never a "try the fallback provider" situation — the
        // caller no longer wants an answer at all. Stop immediately.
        if (isAbort(e)) throw e;
        const status = e.response?.status;
        const body = typeof e.response?.data === 'string' ? e.response.data : JSON.stringify(e.response?.data || '');
        const isRateLimited = status === 429 || /rate.?limit|too many requests|quota|insufficient|balance/i.test(`${e.message || ''} ${body}`);
        const canFallbackModel = provider.fallbackModel && provider.fallbackModel !== provider.model;

        // A 429 is not a model-compatibility error. Don't hammer NVIDIA again
        // with the exact same key. Try its configured fallback model once, then
        // leave the provider so the outer fallback can use a different backend.
        if (canFallbackModel && ([400, 403, 404, 422, 429].includes(status) || e.code === 'EMPTY_RESPONSE')) {
          logger.warn({ model: provider.model, fallback: provider.fallbackModel, provider: provider.name, status }, 'AI model unavailable/rate-limited, trying fallback model');
          try {
            const fbKey = provider.local ? 'local' : this.nextKeyFresh(provider);
            return await this._completionWithModel(provider, provider.fallbackModel, messages, tools, fbKey, signal);
          } catch (e2) {
            if (isAbort(e2)) throw e2;
            lastErr = e2;
          }
        }
        // AgentRouter (and similar): walk the full modelChain on 403/empty
        const chain = Array.isArray(provider.modelChain) ? provider.modelChain : [];
        if (chain.length && ([400, 403, 404, 422].includes(status) || e.code === 'EMPTY_RESPONSE')) {
          for (const m of chain) {
            if (!m || m === provider.model || m === provider.fallbackModel) continue;
            try {
              logger.warn({ model: m, provider: provider.name, status }, 'trying next model in chain');
              return await this._completionWithModel(provider, m, messages, tools, key, signal);
            } catch (e3) {
              if (isAbort(e3)) throw e3;
              lastErr = e3;
            }
          }
        }

        if (isRateLimited) {
          try { this._markKeyLimited(provider, key); } catch {}
          logger.warn({
            provider: provider.name,
            status,
            attempt: i + 1,
            keys: (provider.apiKeys || []).length,
          }, 'rate limited — rotating to next API key');
          continue;
        }
        if (status === 401 || status === 403) {
          try { this._markKeyLimited(provider, key); } catch {}
          logger.warn({ provider: provider.name, status, attempt: i + 1 }, 'auth error — trying next API key');
          continue;
        }
        const isEmpty = e.code === 'EMPTY_RESPONSE' || status === 422;
        if (![400, 404, 422, 401, 403].includes(status) && !isEmpty) break;
      }
    }

    // Ollama fallback only when explicitly configured (OLLAMA_ENABLED / OLLAMA_BASE_URL).
    if (provider.name !== 'ollama' && config.ai.providers.ollama) {
      const local = config.ai.providers.ollama;
      try {
        return await this._completionWithModel(local, local.model, messages, tools, 'local');
      } catch (e) {
        // Swallow pure connection-refused — do not replace a better remote error with ECONNREFUSED.
        const msg = String(e?.message || '');
        if (!/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/i.test(msg)) lastErr = e;
        if (local.fallbackModel && local.fallbackModel !== local.model) {
          try {
            return await this._completionWithModel(local, local.fallbackModel, messages, tools, 'local');
          } catch (e2) {
            const msg2 = String(e2?.message || '');
            if (!/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/i.test(msg2)) lastErr = e2;
          }
        }
      }
    }

    // Cross-provider fallback: try configured chat providers, then configured
    // coding backends so a temporary provider outage does not hard-fail chat.
    const tried = new Set([provider.name, 'ollama']);
    const emergency = [
      ...providersWithKeys(),
      ...codingProvidersWithKeys(),
    ];
    for (const name of emergency) {
      if (!name || tried.has(name)) continue;
      tried.add(name);
      const alt = { name, ...(config.ai.providers[name] || {}) };
      if (!alt.baseUrl && !alt.local) continue;
      if (!providerHasKey(name) && !alt.local) continue;
      try {
        logger.warn({ from: provider.name, to: name, err: lastErr?.message }, 'falling back to next AI provider');
        const key = alt.local ? 'local' : this.nextKey(alt);
        return await this._completionWithModel(alt, alt.model, messages, tools, key, signal);
      } catch (eAlt) {
        if (isAbort(eAlt)) throw eAlt;
        lastErr = eAlt;
        if (alt.fallbackModel && alt.fallbackModel !== alt.model) {
          try {
            return await this._completionWithModel(alt, alt.fallbackModel, messages, tools, alt.local ? 'local' : this.nextKey(alt), signal);
          } catch (eAlt2) {
            if (isAbort(eAlt2)) throw eAlt2;
            lastErr = eAlt2;
          }
          // also walk modelChain if present
          if (Array.isArray(alt.modelChain)) {
            for (const m of alt.modelChain) {
              if (!m || m === alt.model || m === alt.fallbackModel) continue;
              try {
                return await this._completionWithModel(alt, m, messages, tools, alt.local ? 'local' : this.nextKey(alt), signal);
              } catch (eAlt3) {
                if (isAbort(eAlt3)) throw eAlt3;
                lastErr = eAlt3;
              }
            }
          }
        }
      }
    }

    // If multimodal failed everywhere, last-ditch: strip media and try Agnes text-only.
    if (hasMultimodalContent(messages) && config.ai.providers.agnes && (config.ai.providers.agnes.apiKeys || []).length) {
      try {
        const textOnly = stripMultimodal(messages);
        logger.warn('final multimodal fallback — Agnes text-only');
        return await this._completionWithModel(
          config.ai.providers.agnes,
          config.ai.providers.agnes.model || 'agnes-2.5-flash',
          textOnly,
          tools,
          this.nextKey(config.ai.providers.agnes),
          signal
        );
      } catch (eM) {
        if (!isAbort(eM)) lastErr = eM;
      }
    }

    throw lastErr;
  }

  /** One-shot completion, no tools, no history — used internally (e.g. website generation).
   *  Pass { signal } to cancel. Pass { coding: true } to prefer the coding sub-agent
   *  (AgentRouter when configured), falling back to Agnes/active provider. */
  async simpleComplete(prompt, system, opts = {}) {
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: prompt });
    if (opts.coding) {
      return this._codingComplete(messages, opts.signal);
    }
    const msg = await this._completion(messages, [], opts.signal);
    const text = sanitizeOutbound(msg?.content) || '';
    if (!text.trim()) {
      throw emptyResponseError(getActiveProviderName(), getActiveProvider()?.model, 'simpleComplete returned blank text');
    }
    return text;
  }

  /** Force a specific provider by name (sub-agents: agentrouter / gemini / groq / agnes). */
  async simpleCompleteOn(providerName, prompt, system, opts = {}) {
    const name = String(providerName || '').toLowerCase();
    const provider = config.ai.providers[name];
    if (!provider) throw new Error(`Unknown provider: ${providerName}`);
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: prompt });
    const keys = provider.apiKeys || [];
    if (!keys.length && !provider.local) throw new Error(`No API key for ${name}`);
    const key = provider.local ? 'local' : keys[0];
    const models = [];
    if (provider.model) models.push(provider.model);
    if (provider.fallbackModel && provider.fallbackModel !== provider.model) models.push(provider.fallbackModel);
    if (Array.isArray(provider.modelChain)) {
      for (const m of provider.modelChain) if (m && !models.includes(m)) models.push(m);
    }
    if (!models.length) models.push('default');
    let lastErr;
    for (const model of models) {
      try {
        const msg = await this._completionWithModel(provider, model, messages, [], key, opts.signal);
        const text = sanitizeOutbound(msg?.content) || '';
        if (text.trim()) return text;
      } catch (e) {
        lastErr = e;
      }
    }
    // Fallback coding path
    if (opts.coding !== false) {
      try { return await this._codingComplete(messages, opts.signal); } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error(`simpleCompleteOn(${name}) failed`);
  }

  /**
   * Coding sub-agent path for build_website / fix_zip.
   * Prefer AgentRouter (claude-opus-5 + chain) when AI_CODING_PROVIDER=agentrouter and key is set;
   * otherwise use the active chat provider (Agnes by default). Always falls back to Agnes on failure.
   */
  async _codingComplete(messages, signal) {
    const codingName = config.ai.codingProvider || 'agentrouter';
    const coding = config.ai.providers[codingName];
    const hasCodingKey = !!(coding && (coding.apiKeys || []).length);
    const agnes = config.ai.providers.agnes;

    const tryProvider = async (name, provider) => {
      if (!provider) throw new Error(`provider ${name} missing`);
      const keys = provider.apiKeys || [];
      if (!keys.length && !provider.local) throw new Error(`No API key for ${name}`);
      const key = provider.local ? 'local' : keys[0];
      const models = [];
      if (provider.model) models.push(provider.model);
      if (provider.fallbackModel && provider.fallbackModel !== provider.model) models.push(provider.fallbackModel);
      if (Array.isArray(provider.modelChain)) {
        for (const m of provider.modelChain) {
          if (m && !models.includes(m)) models.push(m);
        }
      }
      let lastErr;
      for (const model of models) {
        try {
          logger.info({ provider: name, model }, 'coding sub-agent attempt');
          const msg = await this._completionWithModel(provider, model, messages, [], key, signal);
          const text = sanitizeOutbound(msg.content) || '';
          if (text.trim()) {
            logger.info({ provider: name, model, chars: text.length }, 'coding sub-agent success');
            return text;
          }
          lastErr = new Error(`${name}/${model} empty response`);
        } catch (e) {
          if (e?.name === 'CanceledError' || e?.code === 'ERR_CANCELED' || signal?.aborted) throw e;
          lastErr = e;
          logger.warn({ provider: name, model, err: e.message, status: e.response?.status }, 'coding model failed');
        }
      }
      throw lastErr || new Error(`${name} coding failed`);
    };

    // 1) Prefer dedicated coding provider (agentrouter / apmix / whatever AI_CODING_PROVIDER says)
    if (hasCodingKey && codingName !== getActiveProviderName()) {
      try {
        return await tryProvider(codingName, coding);
      } catch (e) {
        if (e?.name === 'CanceledError' || e?.code === 'ERR_CANCELED' || signal?.aborted) throw e;
        logger.warn({ err: e.message, codingName }, 'coding provider failed — trying next fallback');
      }
    }

    // 2) Coding sub-agents only (apmix / agentrouter / groq / gemini / nvidia / …) — not openai/xai/anthropic
    const tried = new Set(hasCodingKey ? [codingName] : []);
    for (const name of codingProvidersWithKeys()) {
      if (tried.has(name)) continue;
      tried.add(name);
      try {
        return await tryProvider(name, config.ai.providers[name]);
      } catch (e) {
        if (e?.name === 'CanceledError' || e?.code === 'ERR_CANCELED' || signal?.aborted) throw e;
        logger.warn({ err: e.message, name }, 'coding fallback provider failed — next');
      }
    }

    throw emptyResponseError(getActiveProviderName(), getActiveProvider()?.model, 'all coding providers returned blank text');
  }

  /**
   * Runs the full agent loop for a user turn.
   * @param {object} params
   * @param {string} params.system - system prompt
   * @param {Array}  params.history - prior {role, content} turns (short window)
   * @param {string|Array} params.userText - the new user message. Plain string for text-only
   *   turns, or an OpenAI-style content-block array (e.g. [{type:'text',...},
   *   {type:'image_url',...}]) for vision turns (image sent by the user).
   * @param {object} params.toolCtx - context passed to tool implementations (sock, chatId, senderJid, isGroup, groupMeta, sendFile, sendImage, sendVideo)
   * @returns {Promise<string>} final assistant text
   */
  async runAgent({ system, history, userText, toolCtx }) {
    const currentText = userTextForRouting(userText);
    const isShortFollowUp = /^(?:yes|yeah|yep|sure|go ahead|do it|continue|proceed|please do|make it|build it|create it|send it)(?:[.!?,\s]|$)/i.test(currentText.trim());
    const previousUserText = isShortFollowUp && Array.isArray(history)
      ? userTextForRouting([...history].reverse().find((turn) => turn?.role === 'user')?.content)
      : '';
    const attachmentName = toolCtx?.attachmentInfo?.fileName || toolCtx?.attachmentName || '';
    const toolRequestText = `${previousUserText} ${currentText} ${attachmentName}`.trim();
    const tools = selectToolsForRequest(getToolsFor(toolCtx.isGroup), toolRequestText);
    const userBlob = currentText;
    // give tools access to this client for things like build_website / generate_image
    toolCtx.aiClient = this;

    const messages = [
      { role: 'system', content: system },
      ...(history || []),
      { role: 'user', content: userText },
    ];

    // Tools whose side effects are visible/irreversible if run twice (sending media,
    // posting messages, spending currency, etc). If the model asks for the exact same
    // call again later in the same turn, we don't re-run it — we hand back the first
    // result again so the model can still reason about it, but nothing gets sent twice.
    // Media / side-effect tools: allow AT MOST ONE successful execution per turn,
    // regardless of slight arg differences (models often re-call generate_image with
    // a paraphrased prompt and would otherwise spam the chat 2–3 times).
    const ONCE_PER_TURN_TOOLS = new Set([
      'generate_image', 'generate_video', 'send_sticker', 'send_voice_note',
      'build_website', 'build_project', 'send_meme', 'send_game_image',
      'play_song', 'search_music', 'ytmp3', 'search_download_video', 'download_video_url',
      'send_poll', 'create_poll', 'react_to_message',
    ]);
    // Progress chatter is OFF by default — never post "On it…" or tool names in chat.
    // Tools run silently; only the final answer / media is sent. Opt-in: AGENT_PROGRESS_FEEDBACK=true
    // (still never leaks raw tool names like generate_image).
    const PROGRESS_TOOLS = new Set([
      'build_website', 'build_project', 'fix_zip', 'analyze_zip', 'run_subagents',
      'repo_work', 'push_to_github', 'browser_navigate', 'browser_diagnose', 'browser_screen_record',
      'web_search', 'search', 'linux_shell', 'server_exec', 'preview_website',
    ]);
    // Media/search tools must NEVER spam the chat with "failed / trying next route".
    // Failures stay internal; the model picks a silent fallback and delivers one clean result.
    const SILENT_FAIL_TOOLS = new Set([
      'play_song', 'search_music', 'ytmp3', 'search_download_video', 'download_video_url',
      'get_lyrics', 'search_lyrics', 'browser_screenshot', 'browser_navigate', 'scrape_webpage',
      'web_search', 'github_get_repo', 'github_list_repos',
    ]);
    const executedThisTurn = new Map(); // key -> result
    let lastProgressAt = 0;
    const progressMinGapMs = Number(process.env.AGENT_PROGRESS_GAP_MS || 2500);
    const feedbackEnabled = (process.env.AGENT_PROGRESS_FEEDBACK || '') === 'force';
    // Error progress messages default OFF. They were flooding DMs/groups with
    // "I'll diagnose it and use another route" spam. Owner can force with AGENT_ERROR_FEEDBACK=on.
    // Even when on, SILENT_FAIL_TOOLS never surface failures to chat.
    const errorFeedbackEnabled = (process.env.AGENT_ERROR_FEEDBACK || 'off') === 'on';

    const HUMAN_PROGRESS = {
      build_website: 'Building that…',
      build_project: 'Scaffolding the project…',
      fix_zip: 'Fixing the zip…',
      analyze_zip: 'Reading the project…',
      run_subagents: 'Working on it in parallel…',
      repo_work: 'Working on the repo…',
      push_to_github: 'Pushing to GitHub…',
      web_search: 'Searching…',
      search: 'Searching…',
      browser_navigate: 'Checking the page…',
      browser_diagnose: 'Checking and repairing the browser…',
      linux_shell: 'Running something on the server…',
      server_exec: 'Running something on the server…',
      preview_website: 'Grabbing a preview…',
      search_download_video: 'Downloading…',
      download_video_url: 'Downloading…',
      ytmp3: 'Pulling audio…',
    };

    const feedback = async (line) => {
      if (!feedbackEnabled || !toolCtx?.sendText) return;
      const now = Date.now();
      if (now - lastProgressAt < progressMinGapMs) return;
      lastProgressAt = now;
      try {
        // Never allow tool ids / function names into chat.
        const safe = String(line || '')
          .replace(/\b[a-z][a-z0-9_]{2,40}\b/gi, (w) => (HUMAN_PROGRESS[w] ? HUMAN_PROGRESS[w] : w))
          .replace(/generate_image|generate_video|tool_call|function_call/gi, '')
          .trim();
        if (!safe || /[_]|generate_|tool/i.test(safe)) return;
        await (toolCtx.sendProgress || toolCtx.sendText)(safe.slice(0, 200));
      } catch {}
    };

    const TOOL_LABELS = {
      linux_shell: 'the server command', server_exec: 'the server command', write_file: 'the file edit',
      read_file: 'the file inspection', browser_navigate: 'the browser navigation', browser_screenshot: 'the screenshot',
      browser_screen_record: 'the screen recording', browser_diagnose: 'the browser repair', install_dependency: 'the dependency install',
      build_website: 'the website build', build_project: 'the project build', fix_zip: 'the zip fix',
      run_subagents: 'the parallel worker step', repo_work: 'the repository work', project_scan: 'the project scan',
    };
    const toolLabel = (name) => TOOL_LABELS[name] || String(name || 'tool').replace(/_/g, ' ');
    let lastToolFailure = null;

    // Auto-plan nudge for heavy goals (model still decides tools; this biases toward task_plan first).
    if (tools.some((tool) => tool.function?.name === 'task_plan') && /\b(build|create|make|fix|repair|debug|implement|refactor|deploy|scaffold|website|project|zip)\b/i.test(userBlob)
        && !/\btask_plan\b/i.test(userBlob)) {
      messages.push({
        role: 'system',
        content: 'For this request: if it is multi-step, call task_plan first (brief), then execute tools. Send no fluff — work and report results. Use run_subagents when the work cleanly splits.',
      });
    }

    let steps = 0;
    while (steps < config.ai.maxToolSteps) {
      steps++;
      // No "On it…" spam — typing indicator is enough presence.
      let msg;
      try {
        msg = await this._completion(messages, tools);
      } catch (compErr) {
        // If tools schema blows up a free model, retry once with no tools so chat still works.
        const em = String(compErr?.message || '');
        if (tools && tools.length && /400|413|tool|schema|function|too large|token limit|TPM|ITPM/i.test(em)) {
          logger.warn({ err: em.slice(0, 200) }, 'completion with tools failed — retrying without tools');
          try {
            msg = await this._completion(messages, []);
          } catch (e2) {
            throw e2;
          }
        } else {
          throw compErr;
        }
      }
      messages.push(msg);

      const calls = msg.tool_calls || [];
      if (!calls.length) {
        let text = sanitizeOutbound(msg.content) || '';
        // If the model leaked a tool-call as plain text, strip it so chat never sees raw function JSON
        if (/^\s*\{\s*"type"\s*:\s*"function"/i.test(text) || /"name"\s*:\s*"(analyze_zip|build_|generate_|send_)/i.test(text)) {
          logger.warn({ preview: text.slice(0, 120) }, 'model returned tool-call as text — stripping');
          text = stripThinkTags(text);
          if (!text.trim()) {
            // Nudge for a real reply
            messages.push({
              role: 'user',
              content: 'Do not output function or tool JSON. Reply to the user in normal natural language only.',
            });
            try {
              const retry = await this._completion(messages, tools);
              text = stripThinkTags(retry?.content) || '';
            } catch {}
          }
        }
        if (!text.trim()) {
          logger.warn({ step: steps }, 'agent received empty final message — retrying once');
          // One soft retry: nudge the model to produce a user-facing reply
          messages.push({
            role: 'user',
            content: 'Your previous reply was empty. Respond to the user now with a helpful answer in plain text. Do not return blank text or tool JSON.',
          });
          try {
            const retry = await this._completion(messages, tools);
            const retryText = stripThinkTags(retry?.content) || '';
            if (retryText.trim() || (retry?.tool_calls || []).length) {
              if ((retry?.tool_calls || []).length) {
                messages.push(retry);
                // fall through by treating as if we got tool calls — re-enter loop body via continue pattern
              } else {
                return retryText;
              }
              // Process tool calls from retry (only first — single tool-call safety)
              const retryCalls = (retry.tool_calls || []).slice(0, 1);
              for (const call of retryCalls) {
                let args = {};
                try { args = JSON.parse(call.function.arguments || '{}'); } catch { args = {}; }
                const name = call.function.name;
                let result;
                try {
                  result = await executeTool(name, args, toolCtx);
                } catch (te) {
                  result = { ok: false, error: te.message };
                }
                messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
              }
              continue;
            }
          } catch (re) {
            logger.warn({ err: re.message }, 'empty-response retry failed');
          }
          return "I didn't get a usable reply just now. Try again in a second.";
        }
        return text;
      }

      // Agentic multi-tool: run up to MAX_TOOLS_PER_STEP calls from one model turn.
      // Side-effect tools still de-dupe via ONCE_PER_TURN_TOOLS. Read-only tools
      // (search, scrape, calculate, memory) can run together so the agent plans less lag.
      const MAX_TOOLS_PER_STEP = Number(process.env.AI_MAX_TOOLS_PER_STEP || 5);
      if (calls.length > MAX_TOOLS_PER_STEP) {
        logger.warn({ count: calls.length, keep: MAX_TOOLS_PER_STEP, names: calls.map((c) => c.function?.name) }, 'capping tool_calls this step');
        calls.length = MAX_TOOLS_PER_STEP;
      } else if (calls.length > 1) {
        logger.info({ count: calls.length, names: calls.map((c) => c.function?.name) }, 'agent multi-tool step');
      }

      // De-dupe within this model response + across the whole turn for once-per-turn tools.
      const seenInThisResponse = new Set();

      for (const call of calls) {
        let args = {};
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch {
          args = {};
        }

        const name = call.function.name;
        // For once-per-turn tools key by name only so paraphrased prompts still de-dupe.
        const signature = ONCE_PER_TURN_TOOLS.has(name) ? name : `${name}:${JSON.stringify(args)}`;
        const guarded = ONCE_PER_TURN_TOOLS.has(name);

        let result;
        if (guarded && (executedThisTurn.has(signature) || seenInThisResponse.has(signature))) {
          logger.warn({ tool: name }, 'agent: skipped duplicate non-idempotent tool call');
          const prev = executedThisTurn.get(signature) || { ok: true };
          result = { ...prev, ok: true, note: 'Already sent earlier in this turn — not sending again.' };
        } else {
          // Arguments may include short-lived credentials (for example a GitHub
          // token supplied for a single push). Do not place them in server logs.
          logger.info({ tool: name }, 'agent: executing tool');
          // Silent by default. Optional human status only (never raw tool names).
          if (feedbackEnabled && PROGRESS_TOOLS.has(name) && HUMAN_PROGRESS[name]) {
            await feedback(HUMAN_PROGRESS[name]);
          }
          // Remember what we're doing so follow-ups ("done?", "and the repo?") stay coherent.
          try {
            const ws = toolCtx.workSession;
            if (ws && toolCtx.chatId && toolCtx.memoryUserId) {
              const stepLabel = {
                build_website: 'building website',
                build_project: 'scaffolding project',
                fix_zip: 'fixing zip',
                analyze_zip: 'analyzing zip',
                push_to_github: 'pushing to github',
                repo_work: 'repo work',
                generate_image: 'generating image',
                generate_video: 'generating video',
                web_search: 'searching web',
                run_subagents: 'running sub-agents',
              }[name] || `tool:${name}`;
              ws.update(toolCtx.chatId, toolCtx.memoryUserId, {
                status: 'in_progress',
                lastTool: name,
                step: stepLabel,
              });
            }
          } catch {}
          if (errorFeedbackEnabled && lastToolFailure && typeof toolCtx.sendProgress === 'function' && !SILENT_FAIL_TOOLS.has(name) && !SILENT_FAIL_TOOLS.has(lastToolFailure.tool)) {
            if (name === lastToolFailure.tool) {
              // Do not let the model burn the tool budget repeating the exact
              // failing route. Give it the real failure and force a different
              // recovery decision on the next model step — silently for media tools.
              messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: false, error: `Previous ${name} attempt failed: ${lastToolFailure.error}. Do not repeat the same tool immediately; choose a different diagnostic, install, edit, or fallback tool.` }) });
              lastToolFailure = null;
              continue;
            }
            lastToolFailure = null;
          } else if (lastToolFailure && name === lastToolFailure.tool) {
            // Always block exact-same-tool retries (even when feedback is off).
            messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: false, error: `Previous ${name} attempt failed: ${lastToolFailure.error}. Do not repeat the same tool; use a different fallback.` }) });
            lastToolFailure = null;
            continue;
          }
          const t0 = Date.now();
          result = await executeTool(name, args, toolCtx);
          const ms = Date.now() - t0;
          if (result?.ok === false) {
            const err = String(result?.error || result?.message || 'unknown error').replace(/\s+/g, ' ').slice(0, 260);
            lastToolFailure = { tool: name, error: err };
            // Only surface failures for non-media tools when explicitly enabled.
            if (errorFeedbackEnabled && !SILENT_FAIL_TOOLS.has(name) && typeof toolCtx.sendProgress === 'function') {
              try {
                await toolCtx.sendProgress(`⚠️ ${toolLabel(name)} hit a snag — switching approach.`);
              } catch {}
            }
          }
          try {
            const ws = toolCtx.workSession;
            if (ws && toolCtx.chatId && toolCtx.memoryUserId) {
              const ok = result && result.ok !== false;
              const doneTools = new Set(['build_website', 'build_project', 'generate_image', 'generate_video', 'push_to_github', 'fix_zip']);
              ws.update(toolCtx.chatId, toolCtx.memoryUserId, {
                status: ok && doneTools.has(name) ? 'done' : (ok ? 'in_progress' : 'failed'),
                lastTool: name,
                step: ok ? `${name} ok (${Math.round(ms / 1000)}s)` : `${name} failed: ${String(result?.error || '').slice(0, 120)}`,
                note: ok ? (result?.message || result?.summary || '').toString().slice(0, 200) : String(result?.error || '').slice(0, 200),
              });
            }
          } catch {}
          if (ms > 15000) logger.info({ tool: name, ms }, 'slow tool finished');
          if (guarded) executedThisTurn.set(signature, result);
        }
        seenInThisResponse.add(signature);

        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
    }

    // Tool budget exhausted — try one last plain text reply (no tools) so the user never sees a blank.
    try {
      messages.push({
        role: 'user',
        content: 'Give a brief final reply to the user now in plain text only. Do not call tools. If you already completed the action (image sent, file sent, etc.), one short confirmation line is enough.',
      });
      const finalMsg = await this._completion(messages, []);
      const finalText = sanitizeOutbound(finalMsg?.content) || '';
      if (finalText.trim()) return finalText;
    } catch (e) {
      logger.warn({ err: e.message }, 'runAgent final text nudge failed');
    }

    // If side-effect tools already ran this turn, silence is better than a scary blank warning.
    if (executedThisTurn.size > 0) {
      const names = [...executedThisTurn.keys()].map((k) => String(k).split(':')[0]);
      if (names.some((n) => /generate_image|generate_video|send_|build_|fix_zip|make_sticker/i.test(n))) {
        // A tool can complete successfully while the model forgets to produce a
        // final message. Never leave the user wondering whether work finished.
        return `Completed: ${names.join(', ')}.`;
      }
      return `Completed: ${names.join(', ')}.`;
    }
    return '';
  }

  /**
   * Agnes Image (text-to-image / image-to-image / multi-image composition).
   * https://agnes-ai.com/en/docs — POST /v1/images/generations
   * @param {object} p
   * @param {string} p.prompt
   * @param {string} [p.size] - '1K' | '2K' | '3K' | '4K' (default '1K')
   * @param {string} [p.ratio] - '1:1' | '3:4' | '4:3' | '16:9' | '9:16' | '2:3' | '3:2' | '21:9'
   * @param {string[]} [p.image] - input image URL(s) or data URIs, for image-to-image / composition
   * @returns {Promise<{url?:string, b64_json?:string}>}
   */
  async generateImage({ prompt, size = '1K', ratio, image }) {
    const body = { model: config.ai.imageModel, prompt, size };
    if (ratio) body.ratio = ratio;
    const extra_body = { response_format: 'url' };
    if (image && image.length) extra_body.image = image;
    body.extra_body = extra_body;

    const { data } = await this._http(config.ai.providers.agnes, this.nextKey(config.ai.providers.agnes)).post('/images/generations', body);
    const item = data?.data?.[0];
    if (!item) throw new Error('Agnes Image returned no result.');
    return item;
  }

  /**
   * Agnes Video (text-to-video / image-to-video / keyframe animation). Async task API:
   * creates the task, then polls until it completes or the configured timeout is hit.
   * https://agnes-ai.com/en/docs — POST /v1/videos, GET /agnesapi?video_id=...
   * @param {object} p
   * @param {string} p.prompt
   * @param {string} [p.image] - image URL for image-to-video
   * @param {string} [p.negativePrompt]
   * @param {number} [p.numFrames] - must be <=441 and follow 8n+1 (default 121 ≈ 5s @ 24fps)
   * @param {number} [p.frameRate] - default 24
   * @param {number} [p.width] - default 1152
   * @param {number} [p.height] - default 768
   * @param {string[]} [p.keyframes] - if provided, generates a keyframe-transition video
   */
  async generateVideo({ prompt, image, negativePrompt, numFrames = 121, frameRate = 24, width = 1152, height = 768, keyframes }) {
    const body = {
      model: config.ai.videoModel,
      prompt,
      width,
      height,
      num_frames: numFrames,
      frame_rate: frameRate,
    };
    if (negativePrompt) body.negative_prompt = negativePrompt;
    if (image) body.image = image;
    if (keyframes && keyframes.length) {
      body.extra_body = { image: keyframes, mode: 'keyframes' };
    }

    const videoKey = this.nextKey(config.ai.providers.agnes);
    const { data: created } = await this._http(config.ai.providers.agnes, videoKey).post('/videos', body);
    const videoId = created.video_id || created.task_id || created.id;
    if (!videoId) throw new Error('Agnes Video did not return a task id.');

    const deadline = Date.now() + config.ai.videoPollTimeoutMs;
    let last = created;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, config.ai.videoPollIntervalMs));
      let poll;
      try {
        const res = await axios.get(`${AGNES_ROOT}/agnesapi`, {
          params: { video_id: videoId, model_name: config.ai.videoModel },
          headers: { Authorization: `Bearer ${videoKey}` },
          timeout: 30000,
        });
        poll = res.data;
      } catch (e) {
        // try alternate poll paths used by some Agnes deployments
        try {
          const res2 = await this._http(config.ai.providers.agnes, videoKey).get(`/videos/${videoId}`);
          poll = res2.data;
        } catch {
          logger.warn({ err: e.message }, 'video poll error');
          continue;
        }
      }
      last = poll || last;
      const status = String(poll?.status || poll?.state || poll?.data?.status || '').toLowerCase();
      if (status === 'completed' || status === 'succeeded' || status === 'success' || status === 'done') {
        return normalizeVideoResult(poll, videoId);
      }
      if (status === 'failed' || status === 'error') {
        throw new Error(poll?.error?.message || poll?.message || 'Video generation failed.');
      }
    }
    return { ...normalizeVideoResult(last, videoId), timedOut: true };
  }
}

function normalizeVideoResult(poll, videoId) {
  const p = poll || {};
  const url =
    p.metadata?.url ||
    p.metadata?.video_url ||
    p.url ||
    p.video_url ||
    p.output_url ||
    p.output ||
    p.result?.url ||
    p.result?.video_url ||
    p.data?.url ||
    p.data?.video_url ||
    p.videos?.[0]?.url ||
    p.assets?.[0]?.url ||
    null;
  return {
    ...p,
    videoId,
    status: p.status || p.state || 'completed',
    metadata: { ...(p.metadata || {}), url },
    url,
  };
}

module.exports = { AIClient, getActiveProvider, setActiveProvider, resolveProviderName, listProviders };
