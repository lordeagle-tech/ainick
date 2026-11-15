// Parallel coding sub-agents — assign workers to Claude Opus (AgentRouter), Gemini, Groq, etc.
const logger = require('../logger');
const config = require('../config');

const NAMES = ['Nora', 'Theo', 'Milo', 'Ava', 'Kai', 'Rex', 'Lia', 'Zen'];

/** Preferred coding backends in rotation order */
function codingBackends() {
  // Sub-agents for coding only — never openai / anthropic / xai-grok.
  const order = (process.env.SUBAGENT_PROVIDERS || process.env.AI_CODING_CHAIN || 'apmix,agentrouter,nvidia,gemini,groq,agnes')
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s && !['openai', 'anthropic', 'grok', 'xai', 'gpt', 'stability'].includes(s));
  const out = [];
  for (const name of order) {
    const p = config.ai.providers[name];
    if (!p) continue;
    const hasKey = !!(p.apiKeys && p.apiKeys.length) || p.local;
    if (!hasKey) continue;
    out.push({ name, provider: p });
  }
  // Always allow Agnes as last resort if present
  if (!out.find((x) => x.name === 'agnes') && config.ai.providers.agnes) {
    out.push({ name: 'agnes', provider: config.ai.providers.agnes });
  }
  return out;
}

function plan(task, features = []) {
  const feats = (Array.isArray(features) ? features : [features])
    .map((f) => String(f || '').trim())
    .filter(Boolean);
  if (!feats.length) {
    // Split task text into chunks by "and" / commas / newlines
    const parts = String(task || '')
      .split(/\n+|;\s*|\band\b|,/i)
      .map((s) => s.trim())
      .filter((s) => s.length > 8)
      .slice(0, 6);
    if (parts.length >= 2) {
      return parts.map((scope, i) => ({
        agent: NAMES[i % NAMES.length],
        scope: [scope],
      }));
    }
    return [{ agent: NAMES[0], scope: [String(task || 'general work').slice(0, 500)] }];
  }
  return feats.slice(0, 8).map((f, i) => ({
    agent: NAMES[i % NAMES.length],
    scope: [f],
  }));
}

/**
 * Run workers in parallel, each on a different provider when possible.
 * progress(msg) should already route to admin DM only.
 */
async function run(workers, { task, context, aiClient, progress }) {
  const backends = codingBackends();
  if (!backends.length) {
    return { ok: false, error: 'No coding providers configured (need AGENTROUTER / GEMINI / GROQ / AGNES keys).' };
  }

  await progress?.(
    `🧩 Spinning ${workers.length} sub-agent(s): ${workers.map((w) => w.agent).join(', ')}\n` +
      `Backends: ${backends.map((b) => b.name).join(' → ')}`
  );

  const jobs = workers.map(async (w, idx) => {
    const backend = backends[idx % backends.length];
    const prompt =
      `Overall task:\n${String(task || '').slice(0, 4000)}\n\n` +
      (context ? `Context:\n${String(context).slice(0, 3000)}\n\n` : '') +
      `Your ONLY scope:\n${w.scope.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n` +
      `Deliver concrete implementation (full code for your files if coding). Be specific. Do not redo other agents' work.`;

    try {
      await progress?.(`⚡ *${w.agent}* → ${backend.name}…`);
      let text = '';
      if (aiClient && typeof aiClient.simpleCompleteOn === 'function') {
        text = await aiClient.simpleCompleteOn(backend.name, prompt, 'Focused coding sub-agent. Full concrete output only.', {
          coding: true,
        });
      } else if (aiClient && typeof aiClient.simpleComplete === 'function') {
        text = await aiClient.simpleComplete(
          prompt + `\n\n[Use best coding quality; assigned backend preference: ${backend.name}]`,
          'Focused coding sub-agent. Full concrete output only.',
          { coding: true }
        );
      } else {
        text = `(no AI) ${w.agent}: ${w.scope.join(', ')}`;
      }
      await progress?.(`✅ *${w.agent}* done (${backend.name})`);
      return {
        agent: w.agent,
        scope: w.scope,
        backend: backend.name,
        ok: true,
        result: String(text || '').slice(0, 20000),
      };
    } catch (e) {
      logger.warn({ err: e.message, agent: w.agent, backend: backend.name }, 'subagent failed');
      // Fallback once on Agnes
      try {
        if (aiClient && backend.name !== 'agnes') {
          const text = await aiClient.simpleComplete(
            prompt,
            'Focused coding sub-agent fallback.',
            { coding: true }
          );
          await progress?.(`✅ *${w.agent}* done (fallback)`);
          return { agent: w.agent, scope: w.scope, backend: 'fallback', ok: true, result: String(text || '').slice(0, 20000) };
        }
      } catch {}
      await progress?.(`❌ *${w.agent}* failed: ${e.message}`);
      return { agent: w.agent, scope: w.scope, backend: backend.name, ok: false, error: e.message };
    }
  });

  const results = await Promise.all(jobs);
  await progress?.('🔀 Merging worker outputs…');

  const merged = results
    .map((r) => {
      if (!r.ok) return `### ${r.agent} (failed on ${r.backend})\n${r.error}`;
      return `### ${r.agent} [${r.backend}]\nScope: ${r.scope.join(' | ')}\n\n${r.result}`;
    })
    .join('\n\n---\n\n');

  return {
    ok: true,
    workers: results,
    merged,
    summary:
      `All ${results.length} workers finished.\n` +
      results.map((r) => `• ${r.agent} (${r.backend}): ${r.ok ? 'ok' : 'fail'}`).join('\n'),
  };
}

module.exports = { plan, run, NAMES, codingBackends };
