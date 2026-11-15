#!/usr/bin/env node
// Interactive terminal entrypoint for the same tool-using agent used by WhatsApp.
// Run from any project directory: `npm run agent:cli`.
require('dotenv').config();
const readline = require('node:readline');
const path = require('node:path');
const { AIClient } = require('../src/ai/client');
const workspace = require('../src/agent/workspace');

const owner = String(process.env.AGENT_OWNER_JID || process.env.OWNER_IDS || 'cli-owner')
  .split(',')[0].trim();
const ai = new AIClient();
const history = [];

const SYSTEM = `You are the development agent running in a real local workspace.
Work directly on the user's project instead of only explaining what to do.
Inspect before editing. Prefer existing project tools for files, git, builds, tests and shell.
After every meaningful edit, verify it with a relevant syntax check, test or build.
Do not invent command output. Keep the user informed with concise progress messages.
The current workspace root is: ${workspace.WORKSPACE_ROOT}
The user has explicitly granted this agent access to that workspace for development tasks.`;

function print(text) { process.stdout.write(`\n${String(text || '').trim()}\n`); }

async function main() {
  print(`Wa-Agent CLI\nworkspace: ${workspace.WORKSPACE_ROOT}\ntype /help for commands`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'wa-agent> ' });
  rl.prompt();
  for await (const line of rl) {
    const input = line.trim();
    if (!input) { rl.prompt(); continue; }
    if (input === '/exit' || input === '/quit') break;
    if (input === '/help') {
      print('/workspace  show workspace info\n/tree       list the workspace\n/clear      clear conversation\n/exit       quit\n\nOr type a normal task, e.g. "inspect this project, fix the build and run tests".');
      rl.prompt(); continue;
    }
    if (input === '/workspace') { print(JSON.stringify(workspace.info(), null, 2)); rl.prompt(); continue; }
    if (input === '/tree') {
      try { print(workspace.list('.', 250).map(x => `${x.type === 'directory' ? 'd' : 'f'}  ${x.path}`).join('\n')); }
      catch (e) { print(`workspace error: ${e.message}`); }
      rl.prompt(); continue;
    }
    if (input === '/clear') { history.length = 0; print('conversation cleared'); rl.prompt(); continue; }

    try {
      const result = await ai.runAgent({
        system: SYSTEM,
        history,
        userText: input,
        toolCtx: {
          senderJid: owner,
          actorJid: owner,
          sender: owner,
          isGroup: false,
          isOwner: true,
          isAdmin: true,
          chatId: 'cli-workspace',
          cwd: workspace.WORKSPACE_ROOT,
          workspaceRoot: workspace.WORKSPACE_ROOT,
          sendText: async (text) => print(`[progress] ${text}`),
        },
      });
      const answer = typeof result === 'string' ? result : result?.text || result?.answer || JSON.stringify(result);
      print(answer);
      history.push({ role: 'user', content: input }, { role: 'assistant', content: answer });
      if (history.length > 20) history.splice(0, history.length - 20);
    } catch (error) {
      print(`agent error: ${error.message}`);
    }
    rl.prompt();
  }
  rl.close();
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
