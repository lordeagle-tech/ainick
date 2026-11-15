// Unicode text styling for WhatsApp messages.
// WhatsApp text messages cannot select an arbitrary .ttf/.otf font. These styles
// use Unicode mathematical/symbol alphabets so the recipient sees the styling
// without installing a font. Characters without a safe Unicode equivalent are
// left unchanged.

const ASCII = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function range(start) {
  return Array.from({ length: 26 }, (_, i) => String.fromCodePoint(start + i));
}

const maps = {};
function makeMap(upperStart, lowerStart, digitStart) {
  const out = {};
  const upper = range(upperStart);
  const lower = range(lowerStart);
  const digits = digitStart == null ? null : Array.from({ length: 10 }, (_, i) => String.fromCodePoint(digitStart + i));
  for (let i = 0; i < 26; i++) { out[ASCII[i]] = upper[i]; out[ASCII[26 + i]] = lower[i]; }
  if (digits) for (let i = 0; i < 10; i++) out[String(i)] = digits[i];
  return out;
}

maps.bold = makeMap(0x1D400, 0x1D41A, 0x1D7CE);
maps.italic = makeMap(0x1D434, 0x1D44E, null);
maps.bolditalic = makeMap(0x1D468, 0x1D482, null);
maps.sans = makeMap(0x1D5A0, 0x1D5BA, 0x1D7E2);
maps.sansbold = makeMap(0x1D5D4, 0x1D5EE, 0x1D7EC);
maps.sansitalic = makeMap(0x1D608, 0x1D622, null);
maps.sansbolditalic = makeMap(0x1D63C, 0x1D656, null);
maps.monospace = makeMap(0x1D670, 0x1D68A, 0x1D7F6);
maps.double = makeMap(0x1D538, 0x1D552, 0x1D7D8);
maps.fraktur = makeMap(0x1D504, 0x1D51E, null);
maps.boldfraktur = makeMap(0x1D56C, 0x1D586, null);

// Script and blackletter have historical Unicode gaps. Fill the common gaps
// explicitly so styling remains useful rather than emitting invalid glyphs.
const scriptUpper = '𝒜ℬ𝒞𝒟ℰℱ𝒢ℋℐ𝒥𝒦ℒℳ𝒩𝒪𝒫𝒬ℛ𝒮𝒯𝒰𝒱𝒲𝒳𝒴𝒵';
const scriptLower = '𝒶𝒷𝒸𝒹ℯ𝒻ℊ𝒽𝒾𝒿𝓀𝓁𝓂𝓃ℴ𝓅𝓆𝓇𝓈𝓉𝓊𝓋𝓌𝓍𝓎𝓏';
maps.script = {};
for (let i = 0; i < 26; i++) { maps.script[ASCII[i]] = Array.from(scriptUpper)[i]; maps.script[ASCII[26+i]] = Array.from(scriptLower)[i]; }
const bsU = Array.from('𝓐𝓑𝓒𝓓𝓔𝓕𝓖𝓗𝓘𝓙𝓚𝓛𝓜𝓝𝓞𝓟𝓠𝓡𝓢𝓣𝓤𝓥𝓦𝓧𝓨𝓩');
const bsL = Array.from('𝓪𝓫𝓬𝓭𝓮𝓯𝓰𝓱𝓲𝓳𝓴𝓵𝓶𝓷𝓸𝓹𝓺𝓻𝓼𝓽𝓾𝓿𝔀𝔁𝔂𝔃');
maps.boldscript = {};
for (let i = 0; i < 26; i++) { maps.boldscript[ASCII[i]] = bsU[i]; maps.boldscript[ASCII[26+i]] = bsL[i]; }

const aliases = {
  normal: 'normal', plain: 'normal', reset: 'normal',
  bold: 'bold', strong: 'bold', thick: 'bold',
  italic: 'italic', slant: 'italic', slanted: 'italic',
  'bold italic': 'bolditalic', 'bold-italic': 'bolditalic', bolditalic: 'bolditalic',
  sans: 'sans', 'sans serif': 'sans', 'sans-serif': 'sans',
  'sans bold': 'sansbold', 'sans-bold': 'sansbold', sansbold: 'sansbold',
  'sans italic': 'sansitalic', 'sans-italic': 'sansitalic', sansitalic: 'sansitalic',
  'sans bold italic': 'sansbolditalic', 'sans-bold-italic': 'sansbolditalic', sansbolditalic: 'sansbolditalic',
  monospace: 'monospace', mono: 'monospace', typewriter: 'monospace', code: 'monospace',
  double: 'double', 'double-struck': 'double', outlined: 'double',
  fraktur: 'fraktur', gothic: 'fraktur', blackletter: 'fraktur',
  'bold fraktur': 'boldfraktur', 'bold gothic': 'boldfraktur',
  script: 'script', cursive: 'script', handwriting: 'script',
  'bold script': 'boldscript', boldscript: 'boldscript',
  fancy: 'script', fancytext: 'script', elegant: 'script',
  blackletter: 'fraktur', dark: 'fraktur',
  circled: 'circled', circles: 'circled', bubble: 'circled',
  squared: 'squared', square: 'squared', boxes: 'squared',
  smallcaps: 'smallcaps', 'small caps': 'smallcaps',
  strike: 'strike', strikethrough: 'strike', crossed: 'strike',
  underline: 'underline', underlined: 'underline',
  upside: 'upside', 'upside down': 'upside', flip: 'upside',
  spaced: 'spaced', aesthetic: 'spaced',
  hearts: 'hearts', heart: 'hearts', stars: 'stars', star: 'stars',
  brackets: 'brackets', bracket: 'brackets',
};

const circledUpper = 'ⒶⒷⒸⒹⒺⒻⒼⒽⒾⒿⓀⓁⓂⓃⓄⓅⓆⓇⓈⓉⓊⓋⓌⓍⓎⓏ';
const circledLower = 'ⓐⓑⓒⓓⓔⓕⓖⓗⓘⓙⓚⓛⓜⓝⓞⓟⓠⓡⓢⓣⓤⓥⓦⓧⓨⓩ';
const squaredUpper = '🄰🄱🄲🄳🄴🄵🄶🄷🄸🄹🄺🄻🄼🄽🄾🄿🅀🅁🅂🅃🅄🅅🅆🅇🅈🅉';
const squaredLower = '🅰🅱🅲🅳🅴🅵🅶🅷🅸🅹🅺🅻🅼🅽🅾🅿🆀🆁🆂🆃🆄🆅🆆🆇🆈🆉';
const smallcaps = { a:'ᴀ',b:'ʙ',c:'ᴄ',d:'ᴅ',e:'ᴇ',f:'ꜰ',g:'ɢ',h:'ʜ',i:'ɪ',j:'ᴊ',k:'ᴋ',l:'ʟ',m:'ᴍ',n:'ɴ',o:'ᴏ',p:'ᴘ',q:'ǫ',r:'ʀ',s:'s',t:'ᴛ',u:'ᴜ',v:'ᴠ',w:'ᴡ',x:'x',y:'ʏ',z:'ᴢ' };
const upside = { a:'ɐ',b:'q',c:'ɔ',d:'p',e:'ǝ',f:'ɟ',g:'ƃ',h:'ɥ',i:'ᴉ',j:'ɾ',k:'ʞ',l:'ʃ',m:'ɯ',n:'u',o:'o',p:'d',q:'b',r:'ɹ',s:'s',t:'ʇ',u:'n',v:'ʌ',w:'ʍ',x:'x',y:'ʎ',z:'z' };

function basicMap(text, map) { return Array.from(String(text)).map(ch => map[ch] || map[ch.toUpperCase()] || ch).join(''); }
function specialMap(text, table) { return Array.from(String(text)).map(ch => table[ch] || table[ch.toLowerCase()] || ch).join(''); }

function styleText(text, style = 'normal') {
  const canonical = aliases[String(style || 'normal').trim().toLowerCase()] || String(style || 'normal').trim().toLowerCase();
  let s = String(text == null ? '' : text);
  if (canonical === 'normal') return s;
  if (maps[canonical]) return basicMap(s, maps[canonical]);
  if (canonical === 'circled') return Array.from(s).map(ch => {
    const u = ch.toUpperCase(), idx = ASCII.indexOf(u);
    if (idx >= 0) return Array.from(ch === u ? circledUpper : circledLower)[idx];
    if (/\d/.test(ch)) return ch === '0' ? '⓪' : String.fromCodePoint(0x2460 + Number(ch) - 1);
    return ch;
  }).join('');
  if (canonical === 'squared') return Array.from(s).map(ch => {
    const u = ch.toUpperCase(), idx = ASCII.indexOf(u);
    if (idx >= 0) return Array.from(ch === u ? squaredUpper : squaredLower)[idx];
    return ch;
  }).join('');
  if (canonical === 'smallcaps') return specialMap(s, smallcaps);
  if (canonical === 'strike') return Array.from(s).map(ch => ch === '\n' ? ch : ch + '\u0336').join('');
  if (canonical === 'underline') return Array.from(s).map(ch => ch === '\n' ? ch : ch + '\u0332').join('');
  if (canonical === 'spaced') return s.split(/(\s+)/).map(part => /^\s+$/.test(part) ? part : Array.from(part).join(' ')).join('');
  if (canonical === 'upside') return Array.from(s).reverse().map(ch => upside[ch.toLowerCase()] || ch).join('');
  if (canonical === 'hearts') return `♡ ${s} ♡`;
  if (canonical === 'stars') return `✦ ${s} ✦`;
  if (canonical === 'brackets') return `『 ${s} 』`;
  return s;
}

function decorateText(text, decoration = 'none') {
  const d = String(decoration || 'none').toLowerCase().trim();
  const t = String(text == null ? '' : text);
  const pairs = {
    none: ['', ''], clean: ['', ''],
    stars: ['✦ ', ' ✦'], star: ['★ ', ' ★'],
    hearts: ['♡ ', ' ♡'], heart: ['♥ ', ' ♥'],
    sparkles: ['✨ ', ' ✨'], fire: ['🔥 ', ' 🔥'],
    crown: ['👑 ', ' 👑'], flower: ['❀ ', ' ❀'],
    arrows: ['➜ ', ' ←'], brackets: ['『 ', ' 』'],
    double: ['╔═ ', ' ═╗'], box: ['┏━━ ', ' ━━┓'],
    line: ['━━ ', ' ━━'],
  };
  const [a,b] = pairs[d] || ['', ''];
  return `${a}${t}${b}`;
}


// Ready-to-send WhatsApp design presets. These intentionally use Unicode glyphs and
// ordinary emoji/symbols so they survive as text messages without a custom font file.
const presets = {
  dark: { style: 'script', decoration: 'none', prefix: '☾ ', suffix: ' ☽', divider: '─' },
  darkcursive: { style: 'script', decoration: 'none', prefix: '🥀 𝓓𝓪𝓻𝓴 𝓥𝓲𝓫𝓮𝓼 🥀\n', suffix: '', divider: '─' },
  gothicdark: { style: 'fraktur', decoration: 'none', prefix: '☾ 🥀 ', suffix: ' 🥀 ☽', divider: '═' },
  aesthetic: { style: 'script', decoration: 'sparkles', prefix: '𓆩♡𓆪 ', suffix: ' 𓆩♡𓆪', divider: '─' },
  cursed: { style: 'fraktur', decoration: 'none', prefix: '𓆩 ', suffix: ' 𓆪', divider: '̷' },
  midnight: { style: 'script', decoration: 'none', prefix: '🌙 ', suffix: ' 🌑', divider: '─' },
  rose: { style: 'script', decoration: 'hearts', prefix: '🥀 ', suffix: ' 🥀', divider: '─' },
  love: { style: 'script', decoration: 'hearts', prefix: '♡ ', suffix: ' ♡', divider: '♡' },
  sad: { style: 'italic', decoration: 'none', prefix: '🕯️ ', suffix: ' 🥀', divider: '─' },
  warning: { style: 'bold', decoration: 'none', prefix: '⚠️ ', suffix: ' ⚠️', divider: '━' },
  announcement: { style: 'boldscript', decoration: 'none', prefix: '╭━━━〔 ✦ 〕━━━╮\n', suffix: '\n╰━━━〔 ✦ 〕━━━╯', divider: '━' },
  box: { style: 'bold', decoration: 'none', prefix: '╔═══════ ✦ ═══════╗\n', suffix: '\n╚═══════ ✦ ═══════╝', divider: '═' },
  crown: { style: 'boldscript', decoration: 'none', prefix: '👑 ', suffix: ' 👑', divider: '─' },
  fire: { style: 'bold', decoration: 'fire', prefix: '', suffix: '', divider: '🔥' },
  angel: { style: 'script', decoration: 'none', prefix: '𓆩♡𓆪 ', suffix: ' 𓆩♡𓆪', divider: '─' },
  devil: { style: 'fraktur', decoration: 'none', prefix: '𓆩😈𓆪 ', suffix: ' 𓆩😈𓆪', divider: '─' },
  royal: { style: 'double', decoration: 'none', prefix: '♛ ', suffix: ' ♛', divider: '═' },
  shadow: { style: 'fraktur', decoration: 'none', prefix: '🕷️ 𓆩 ', suffix: ' 𓆪 🕷️', divider: '─' },
  vampire: { style: 'fraktur', decoration: 'none', prefix: '🩸 🦇 ', suffix: ' 🦇 🩸', divider: '═' },
  witch: { style: 'script', decoration: 'none', prefix: '🕯️ 🪄 ', suffix: ' 🪄 🕯️', divider: '─' },
  skull: { style: 'fraktur', decoration: 'none', prefix: '☠️ ', suffix: ' ☠️', divider: '─' },
  moon: { style: 'script', decoration: 'none', prefix: '☾ ', suffix: ' ☽', divider: '⋆' },
  ocean: { style: 'script', decoration: 'none', prefix: '𓇼 ', suffix: ' 𓇼', divider: '≈' },
  butterfly: { style: 'script', decoration: 'none', prefix: '🦋 ', suffix: ' 🦋', divider: '─' },
  softdark: { style: 'italic', decoration: 'none', prefix: '𓂃 ࣪˖ ִֶָ ', suffix: ' 𓂃 ࣪˖ ִֶָ', divider: '·' },
  darklove: { style: 'boldscript', decoration: 'none', prefix: '🖤🥀 ', suffix: ' 🥀🖤', divider: '─' },
  heartbreak: { style: 'script', decoration: 'none', prefix: '🥀💔 ', suffix: ' 💔🥀', divider: '─' },
  mysterious: { style: 'fraktur', decoration: 'none', prefix: '☾⋆⁺₊⋆ ', suffix: ' ⋆⁺₊⋆☽', divider: '·' },
  elegant: { style: 'script', decoration: 'none', prefix: '❦ ', suffix: ' ❦', divider: '─' },
  minimal: { style: 'script', decoration: 'none', prefix: '⌁ ', suffix: ' ⌁', divider: '·' },
  night: { style: 'boldscript', decoration: 'none', prefix: '🌙🖤 ', suffix: ' 🖤🌙', divider: '━' },
};

function designText(text, preset = 'darkcursive', options = {}) {
  const key = String(preset || 'darkcursive').trim().toLowerCase().replace(/[ _-]+/g, '');
  const cfg = presets[key] || presets.darkcursive;
  const styled = styleText(text, options.style || cfg.style);
  const decorated = options.decoration && options.decoration !== 'none'
    ? decorateText(styled, options.decoration)
    : styled;
  const prefix = options.prefix != null ? String(options.prefix) : cfg.prefix;
  const suffix = options.suffix != null ? String(options.suffix) : cfg.suffix;
  const body = `${prefix}${decorated}${suffix}`;
  if (options.divider === false) return body;
  const divider = String(options.divider || cfg.divider || '─');
  if (!divider) return body;
  const width = Math.min(28, Math.max(8, Number(options.width) || 18));
  // Keep dividers as a separate line so WhatsApp does not merge them into the styled text.
  return `${divider.repeat(width)}\n${body}\n${divider.repeat(width)}`;
}



// Celestial / zodiac / astrology symbol packs for dark-aesthetic WhatsApp text.
// These are ordinary Unicode symbols and emoji, so they can be sent directly.
const symbolPacks = {
  moon: '🌑 🌒 🌓 🌔 🌕 🌖 🌗 🌘 🌙 🌚 🌛 🌜 🌝 ☾ ☽',
  moonphases: '🌑  🌒  🌓  🌔  🌕  🌖  🌗  🌘  🌙  ☾  ☽',
  zodiac: '♈︎ ♉︎ ♊︎ ♋︎ ♌︎ ♍︎ ♎︎ ♏︎ ♐︎ ♑︎ ♒︎ ♓︎',
  planets: '☿ ♀ ⊕ ♂ ♃ ♄ ♅ ♆ ♇',
  celestial: '☉ ☽ ☾ ✦ ✧ ★ ☆ ⋆ ⭑ ⟡ ✩ ✪ ✫ ✬ ✭ ✮ ✯ ✰ 🌙 🌑 🌒 🌓 🌔 🌕 🌖 🌗 🌘',
  stars: '✦ ✧ ★ ☆ ⋆ ⭑ ⟡ ✩ ✪ ✫ ✬ ✭ ✮ ✯ ✰ ❈ ❉ ❊ ❋',
  dark: '☾ ☽ ☠︎ 🕷️ 🥀 🖤 🕯️ 🦇 🩸 🌑 ✦ 𓆩 𓆪',
  witchy: '☾ ☽ 🌙 🕯️ 🪄 🔮 🦉 🐈‍⬛ ✦ ✧ 𓆩 𓆪',
  astrology: '☉ ☽ ☿ ♀ ♂ ♃ ♄ ♅ ♆ ♇ ♈︎ ♉︎ ♊︎ ♋︎ ♌︎ ♍︎ ♎︎ ♏︎ ♐︎ ♑︎ ♒︎ ♓︎',
  aesthetic: '𓆩♡𓆪 𓂃 ࣪˖ ִֶָ ☾ ⋆｡°✩ ✧₊˚ 🪽 🦋 🥀',
  symbols: '𓆩 𓆪 𓂀 𓋹 ☾ ☽ ☉ ✦ ✧ ⟡ ❦ ❧ ♡ ♥︎ ♢ ◇ ༺ ༻ ࿔ ⊹ ⁺₊⋆'
};

const symbolAliases = {
  moons: 'moon', 'moon phases': 'moonphases', 'moon-phase': 'moonphases',
  zodiac: 'zodiac', signs: 'zodiac', 'star signs': 'zodiac',
  planet: 'planets', planets: 'planets', celestial: 'celestial', cosmic: 'celestial',
  astrology: 'astrology', stars: 'stars', dark: 'dark', witchy: 'witchy',
  aesthetic: 'aesthetic', symbols: 'symbols'
};

function symbolPack(name = 'celestial') {
  const raw = String(name || 'celestial').trim().toLowerCase();
  const key = symbolAliases[raw] || raw;
  return symbolPacks[key] || symbolPacks.celestial;
}

function addSymbols(text, pack = 'celestial', position = 'both') {
  const t = String(text == null ? '' : text);
  const symbols = symbolPack(pack);
  if (position === 'before') return `${symbols}\n${t}`;
  if (position === 'after') return `${t}\n${symbols}`;
  return `${symbols}\n${t}\n${symbols}`;
}

function listPresets() { return Object.keys(presets); }

function listStyles() {
  return Object.keys(aliases).filter((x, i, a) => a.indexOf(x) === i).sort();
}

module.exports = { styleText, decorateText, designText, listStyles, listPresets, presets, aliases, symbolPack, addSymbols, symbolPacks, symbolAliases };
