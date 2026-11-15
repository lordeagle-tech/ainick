const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { execFileSync } = cp;
const pkg = require('../package.json');

const root = path.resolve(__dirname, '..');
const syntaxOnly = process.argv.includes('--syntax');
const required = new Set();
const builtins = new Set(require('module').builtinModules);
const files = [];
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (['node_modules','.git','sessions'].includes(name)) continue;
    const p = path.join(dir,name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p);
    else if (/\.(js|cjs|mjs)$/.test(name)) files.push(p);
  }
}
walk(path.join(root,'src'));
for (const file of files) {
  const s = fs.readFileSync(file,'utf8');
  for (const re of [/require\(\s*['"]([^'"]+)['"]\s*\)/g,/from\s*['"]([^'"]+)['"]/g]) {
    let m;
    while ((m=re.exec(s))) {
      const x=m[1];
      if (!x.startsWith('.') && !x.startsWith('node:') && !builtins.has(x)) {
        required.add(x.startsWith('@') ? x.split('/').slice(0,2).join('/') : x.split('/')[0]);
      }
    }
  }
}
const deps = new Set([...Object.keys(pkg.dependencies||{}), ...Object.keys(pkg.optionalDependencies||{})]);
const missing = [...required].filter(x => !deps.has(x));
const localMissing = [];
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  const localSpecs = [];
  for (const re of [/require\(\s*['"]([^'"]+)['"]\s*\)/g, /from\s*['"]([^'"]+)['"]/g]) {
    let m;
    while ((m = re.exec(source))) if (m[1].startsWith('.')) localSpecs.push(m[1]);
  }
  for (const spec of localSpecs) {
    const base = path.resolve(path.dirname(file), spec);
    const candidates = [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, `${base}.json`, path.join(base, 'index.js')];
    if (!candidates.some(fs.existsSync)) localMissing.push(`${path.relative(root, file)} -> ${spec}`);
  }
}
let failed = 0;
console.log(`Nick AI doctor: scanned ${files.length} JS files`);
console.log(`Node: ${process.version}`);
if (missing.length) { console.error('Missing package declarations:', missing.join(', ')); failed=1; }
else console.log('✓ Every external require is declared in package.json');
if (localMissing.length) { console.error('Missing local modules:', localMissing.join('\n')); failed=1; }
else console.log(`✓ Local require targets resolve (${files.length} JS files checked)`);
if (!syntaxOnly) {
  const gitRefs = [];
  const check = (obj,prefix='') => {
    for (const [k,v] of Object.entries(obj||{})) {
      if (typeof v === 'string' && /^(git|github|git\+|ssh\+git):/i.test(v)) gitRefs.push(`${prefix}${k}: ${v}`);
    }
  };
  check(pkg.dependencies); check(pkg.devDependencies);
  if (gitRefs.length) { console.error('Git dependencies found:', gitRefs.join('\n')); failed=1; }
  else console.log('✓ No direct git dependencies');
  try {
    cp.execFileSync(process.execPath,['--check','src/index.js'],{cwd:root,stdio:'inherit'});
    console.log('✓ Entry point syntax OK');
  } catch { failed=1; }
  try {
    cp.execFileSync(process.execPath,['--import','jiti/register','-e',"require('dotenv'); require('pino'); require('@lordeagle21/baileys'); console.log('✓ Core runtime modules load')"],{cwd:root,stdio:'inherit'});
  } catch {
    console.error('✗ Core runtime modules are not installed or Baileys 7 ESM bridge failed. Run npm install.'); failed=1;
  }
  for (const bin of ['ffmpeg']) {
    try { cp.execFileSync('sh',['-lc',`command -v ${bin}`],{stdio:'ignore'}); console.log(`✓ ${bin} available`); }
    catch { console.warn(`⚠ ${bin} not found — media conversion features may be unavailable on this host`); }
  }
}
process.exitCode=failed;

try { execFileSync(process.env.YTDLP_BIN || 'yt-dlp', ['--version'], { stdio: 'ignore', timeout: 5000 }); console.log('✓ yt-dlp available (music audio enabled)'); } catch { console.log('ℹ yt-dlp not found — play_song uses the configured direct audio API, so yt-dlp is optional'); }
