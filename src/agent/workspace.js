// Every path is resolved inside WORKSPACE_ROOT. Commands are deliberately allowlisted.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileP = promisify(execFile);

const WORKSPACE_ROOT = path.resolve(process.env.AGENT_WORKSPACE || process.cwd());
const MAX_OUTPUT = 24000;
const BLOCKED = /(?:^|[;&|]\s*)(?:sudo|su|doas)\b|\b(?:shutdown|reboot|poweroff|mkfs|fdisk|parted|mount|umount|systemctl|service|iptables|nft|useradd|userdel|passwd|chpasswd|visudo)\b|rm\s+-rf\s+\//i;
const ALLOWED = new Set([
  'node','npm','npx','pnpm','yarn','corepack','git','python','python3','pip','pip3',
  'ls','pwd','cat','head','tail','find','grep','rg','sed','awk','sort','uniq','wc',
  'mkdir','cp','mv','rm','touch','test','which','realpath','basename','dirname','du',
  'tar','zip','unzip','gzip','curl','wget','ffmpeg','ffprobe'
]);

function inside(p) {
  const target = path.resolve(WORKSPACE_ROOT, p || '.');
  const rel = path.relative(WORKSPACE_ROOT, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
function safePath(p) {
  const target = path.resolve(WORKSPACE_ROOT, p || '.');
  if (!inside(target)) throw new Error('Access denied: path leaves the agent workspace.');
  return target;
}
function rel(p) { return path.relative(WORKSPACE_ROOT, p) || '.'; }

function list(dir='.', limit=200) {
  const target = safePath(dir);
  const entries = fs.readdirSync(target, { withFileTypes:true }).slice(0, Math.min(Math.max(Number(limit)||50,1),500));
  return entries.map(e => ({ name:e.name, type:e.isDirectory()?'directory':'file', path:rel(path.join(target,e.name)) }));
}
function read(file, startLine=1, maxBytes=100000) {
  const target = safePath(file);
  if (!fs.statSync(target).isFile()) throw new Error('Not a file.');
  const lines = fs.readFileSync(target,'utf8').split('\n');
  const start = Math.max(Number(startLine)||1,1)-1;
  const maxLines = Math.max(1, Math.floor(Number(maxBytes||100000)/8));
  return { path:rel(target), totalLines:lines.length, startLine:start+1, endLine:Math.min(lines.length,start+maxLines), content:lines.slice(start,start+maxLines).join('\n') };
}
function write(file, content) {
  const target = safePath(file);
  fs.mkdirSync(path.dirname(target), { recursive:true });
  fs.writeFileSync(target, String(content), 'utf8');
  return { ok:true, path:rel(target), bytes:Buffer.byteLength(String(content)) };
}
function search(query, dir='.') {
  const target = safePath(dir);
  const q = String(query||'').toLowerCase();
  const hits=[];
  function walk(current) {
    if (hits.length >= 100) return;
    for (const e of fs.readdirSync(current,{withFileTypes:true})) {
      if (e.name === '.git' || e.name === 'node_modules' || e.name === 'data') continue;
      const p=path.join(current,e.name);
      if (e.isDirectory()) walk(p);
      else {
        try { if (fs.readFileSync(p,'utf8').toLowerCase().includes(q)) hits.push(rel(p)); } catch {}
      }
      if (hits.length >= 100) return;
    }
  }
  walk(target);
  return hits;
}
async function run(command, cwd='.', timeoutMs=120000) {
  const text=String(command||'').trim();
  if (!text) throw new Error('Command is empty.');
  if (text.length>4000 || BLOCKED.test(text)) throw new Error('Command blocked by workspace policy.');
  const parts=text.split(/&&|\|\||\||;/).map(x=>x.trim()).filter(Boolean);
  for (const part of parts) {
    if (/^cd(?:\s|$)/i.test(part)) continue;
    const m=part.match(/^([A-Za-z0-9_.\/-]+)/);
    const name=path.basename(m?.[1]||'').toLowerCase();
    if (!ALLOWED.has(name)) throw new Error(`Command "${name||'?'}" is not allowed in the agent workspace.`);
  }
  const dir=safePath(cwd);
  const result=await execFileP('/bin/sh',['-lc',text],{cwd:dir,timeout:Math.min(Math.max(Number(timeoutMs)||120000,1000),300000),maxBuffer:4*1024*1024,env:{...process.env,CI:process.env.CI||'1'}}).catch(e=>e);
  return { ok:!result.code, exitCode:typeof result.code==='number'?result.code:0, cwd:rel(dir), stdout:String(result.stdout||'').slice(-MAX_OUTPUT), stderr:String(result.stderr||'').slice(-MAX_OUTPUT), error:result.code?result.message:undefined };
}
function info() { return { root:WORKSPACE_ROOT, relativeRoot:'.', exists:fs.existsSync(WORKSPACE_ROOT), platform:process.platform, node:process.version }; }
module.exports={WORKSPACE_ROOT,inside,safePath,list,read,write,search,run,info};
