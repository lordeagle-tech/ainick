// WhatsApp can now deliver mentions/participants as @lid. Never treat the numeric LID
// itself as a phone number. Prefer participantAlt/participantPn/groupMetadata mappings.
const fs = require('fs');
const path = require('path');
const { numFromJid } = require('./helpers');

function isLid(jid) { return String(jid || '').endsWith('@lid'); }
function isPn(jid) { return String(jid || '').endsWith('@s.whatsapp.net'); }
// Strip the device suffix WhatsApp adds to multi-device JIDs:
//   195593515315386:34@lid → 195593515315386@lid
//   254119438433:34@s.whatsapp.net → 254119438433@s.whatsapp.net
function bare(jid) { return String(jid || '').replace(/:\d+@/, '@'); }

const knownAliases = new Map();
const aliasCacheFile = path.join(__dirname, '..', '..', 'data', 'jid_aliases.json');
let persistTimer = null;
let seeding = false;

function schedulePersist() {
  if (seeding || persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const out = {};
      for (const [k, v] of knownAliases) {
        if (isLid(k) && isPn(v)) out[k] = v;
      }
      fs.mkdirSync(path.dirname(aliasCacheFile), { recursive: true });
      fs.writeFileSync(aliasCacheFile, JSON.stringify(out, null, 2));
    } catch {}
  }, 2000);
  if (persistTimer.unref) persistTimer.unref();
}

function rememberPair(a, b) {
  if (!a || !b) return;
  const aa = String(a);
  const bb = String(b);
  const pairs = [];
  if (isLid(aa) && isPn(bb)) pairs.push([aa, bb], [bb, aa]);
  if (isPn(aa) && isLid(bb)) pairs.push([bb, aa], [aa, bb]);
  let changed = false;
  for (const [x, y] of pairs) {
    for (const [k, v] of [[x, y], [bare(x), y], [x, bare(y)], [bare(x), bare(y)]]) {
      if (knownAliases.get(k) !== v) { knownAliases.set(k, v); changed = true; }
    }
  }
  if (changed) schedulePersist();
}

// Seed LID↔PN aliases from persisted profiles. Group traffic can deliver an
// @lid before any live mapping (participantAlt/group metadata) is available,
// so owner checks must be able to resolve it immediately after a restart.
function seedAliasesFromProfiles() {
  seeding = true;
  const readJson = (file) => {
    try {
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { return null; }
  };
  // Persisted LID↔PN pairs learned from live traffic in previous runs.
  const cached = readJson(aliasCacheFile);
  for (const [lid, pn] of Object.entries(cached || {})) {
    if (isLid(lid) && isPn(pn)) rememberPair(lid, pn);
  }
  // Persisted user profiles are the long-term source of truth.
  const parsed = readJson(path.join(__dirname, '..', '..', 'data', 'user_profiles.json'));
  const profiles = Array.isArray(parsed) ? parsed : Object.values(parsed || {});
  for (const p of profiles) {
    if (!p || typeof p !== 'object') continue;
    const ids = [
      p.jid, p.phoneNumber, p.userId, p.lid,
      ...(Array.isArray(p.aliases) ? p.aliases : []),
    ].filter(Boolean).map(String);
    const lids = ids.filter(isLid);
    const pns = ids.filter(isPn);
    for (const id of ids) {
      if (/^\d{7,15}$/.test(id)) pns.push(`${id}@s.whatsapp.net`);
    }
    for (const lid of lids) {
      for (const pn of pns) rememberPair(lid, pn);
    }
  }
  seeding = false;
}
seedAliasesFromProfiles();

function addPair(map, a, b) {
  if (!a || !b) return;
  if (isLid(a) && isPn(b)) { map.set(String(a), String(b)); rememberPair(a, b); }
  if (isPn(a) && isLid(b)) { map.set(String(b), String(a)); rememberPair(a, b); }
}

function buildMap(sock, msg, groupMeta) {
  const map = new Map();
  const k = msg?.key || {};
  addPair(map, k.participant, k.participantAlt);
  addPair(map, k.participant, k.participantPn);
  addPair(map, k.remoteJid, k.remoteJidAlt);
  addPair(map, k.senderLid, k.senderPn);
  // Some WhatsApp payloads expose the LID in participant and the phone JID only
  // as remoteJidAlt. Cross-pair those fields as well.
  addPair(map, k.participant, k.remoteJidAlt);
  addPair(map, k.remoteJid, k.participantAlt);
  addPair(map, k.remoteJid, k.participantPn);

  // Replies/mentions can carry the quoted sender only inside contextInfo. Newer
  // WhatsApp clients may put the phone JID in participantPn/participantAlt while
  // participant itself is an @lid. Capture all of those pairs before any gate runs.
  const root = msg?.message || {};
  const contexts = [];
  const walk = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 7) return;
    if (node.contextInfo) contexts.push(node.contextInfo);
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') walk(value, depth + 1);
    }
  };
  walk(root);
  for (const c of contexts) {
    addPair(map, c.participant, c.participantPn);
    addPair(map, c.participant, c.participantAlt);
    addPair(map, c.participantPn, c.participantAlt);
    addPair(map, c.participant, k.remoteJidAlt);
    addPair(map, c.participant, msg?.key?.remoteJidAlt);
    addPair(map, c.participant, msg?.key?.participantAlt);
    addPair(map, c.participant, msg?.key?.participantPn);
  }

  // Current Baileys group metadata exposes phoneNumber/lid pairs on participants.
  for (const p of groupMeta?.participants || []) {
    addPair(map, p.id, p.phoneNumber);
    addPair(map, p.id, p.jid);
    addPair(map, p.lid, p.jid);
    addPair(map, p.lid, p.phoneNumber);
  }

  // Also use the connection identity as a known pair.
  addPair(map, sock?.user?.lid, sock?.user?.id);
  const me = sock?.authState?.creds?.me;
  addPair(map, me?.lid, me?.id);
  return map;
}

function resolve(jid, map) {
  const raw = String(jid || '');
  if (!raw) return raw;
  if (map?.has(raw)) return map.get(raw);
  if (map?.has(bare(raw))) return map.get(bare(raw));
  if (knownAliases.has(raw)) return knownAliases.get(raw);
  if (knownAliases.has(bare(raw))) return knownAliases.get(bare(raw));
  return raw;
}

async function resolveWithSock(jid, sock, map, groupMeta) {
  const raw = String(jid || '');
  if (!raw) return raw;
  let local = resolve(raw, map);
  if (!isLid(local) && isPn(local)) return local;
  if (!isLid(local) && !isLid(raw)) return local;

  // 1) Group participant record often has the real phone next to the LID
  try {
    const rec = participantRecord(raw, groupMeta) || participantRecord(local, groupMeta);
    if (rec) {
      const pn = rec.phoneNumber || rec.jid || rec.participantPn || (isPn(rec.id) ? rec.id : null);
      if (pn && !isLid(pn)) {
        const normalized = isPn(pn) ? pn : (String(pn).includes('@') ? pn : `${String(pn).replace(/\D/g, '')}@s.whatsapp.net`);
        if (!isLid(normalized)) {
          rememberPair(raw, normalized);
          map?.set(raw, normalized);
          return normalized;
        }
      }
    }
  } catch {}

  // 2) Baileys persistent LID → PN store
  try {
    const mapping = sock?.signalRepository?.lidMapping;
    if (mapping?.getPNForLID) {
      const pn = await mapping.getPNForLID(raw);
      if (pn && !isLid(pn)) {
        const normalized = isPn(pn) ? pn : `${String(pn).replace(/\D/g, '')}@s.whatsapp.net`;
        rememberPair(raw, normalized);
        map?.set(raw, normalized);
        return normalized;
      }
    }
  } catch {}

  // 3) Alternate Baileys helpers
  try {
    if (typeof sock?.findUserId === 'function') {
      const found = await sock.findUserId(raw);
      const pn = found?.phoneNumber || found?.jid || found?.pn;
      if (pn && !isLid(pn)) {
        const normalized = isPn(pn) ? pn : `${String(pn).replace(/\D/g, '')}@s.whatsapp.net`;
        rememberPair(raw, normalized);
        map?.set(raw, normalized);
        return normalized;
      }
    }
  } catch {}

  return isLid(local) ? local : raw;
}

function normalizeMany(jids, map) { return [...new Set((jids || []).map(j => resolve(j, map)).filter(Boolean))]; }

/** Resolve every JID (mentions etc.) through the async LID→PN path. */
async function normalizeManyWithSock(jids, sock, map, groupMeta) {
  const out = [];
  for (const j of jids || []) {
    const r = await resolveWithSock(j, sock, map, groupMeta);
    if (r) out.push(r);
  }
  return [...new Set(out)];
}
function number(jid, map) {
  const resolved = resolve(jid, map);
  return numFromJid(resolved);
}

function participantRecord(jid, groupMeta) {
  const raw = String(jid || '');
  if (!raw) return null;
  const candidates = new Set([raw, numFromJid(raw)]);
  return (groupMeta?.participants || []).find((p) => {
    const ids = [p?.id, p?.jid, p?.lid, p?.phoneNumber, p?.participantAlt, p?.participantPn].filter(Boolean).map(String);
    return ids.some((id) => candidates.has(id) || numFromJid(id) === numFromJid(raw));
  }) || null;
}

function resolveIdentity(jid, map, groupMeta) {
  const raw = String(jid || '');
  const rec = participantRecord(raw, groupMeta);
  const phone = rec?.phoneNumber || rec?.jid || rec?.participantPn || (isPn(rec?.id) ? rec.id : null) || resolve(raw, map);
  const resolved = isLid(phone) ? resolve(phone, map) : phone;
  return {
    input: raw,
    jid: resolved || raw,
    phoneNumber: numFromJid(resolved || raw) || '',
    lid: rec?.lid || (isLid(raw) ? raw : ''),
    aliases: [...new Set([raw, rec?.id, rec?.jid, rec?.lid, rec?.phoneNumber, rec?.participantAlt, rec?.participantPn].filter(Boolean).map(String))],
    name: '',
  };
}

function selfIds(sock, map) {
  const raw = [sock?.user?.id, sock?.user?.lid, sock?.authState?.creds?.me?.id, sock?.authState?.creds?.me?.lid].filter(Boolean).map(String);
  const resolved = raw.flatMap(j => [j, resolve(j, map)]).filter(Boolean);
  // Keep raw identities (including opaque @lid values), but only add numeric
  // matching keys for phone-number JIDs. An @lid's numeric part is not a phone
  // number and must never match an unrelated member's @s.whatsapp.net mention.
  return new Set(resolved.flatMap((jid) => {
    const ids = [jid, bare(jid)];
    if (isPn(jid)) ids.push(numFromJid(jid));
    return ids;
  }).filter(Boolean));
}

// Use only WhatsApp's own connection identities for the conversation call gate.
// Unlike general role/identity resolution, do not consult cached or inferred
// aliases here: a mistaken participant mapping must not wake Nick on someone else's tag.
function isSelfJid(jid, sock) {
  const raw = String(jid || '');
  if (!raw) return false;
  const target = bare(raw);
  const own = [sock?.user?.id, sock?.user?.lid, sock?.authState?.creds?.me?.id, sock?.authState?.creds?.me?.lid]
    .filter(Boolean).map((value) => bare(String(value)));
  return own.includes(target);
}


function matchesAny(jid, identities = []) {
  const raw = String(jid || '');
  if (!raw) return false;
  const set = identities instanceof Set ? identities : new Set(identities);
  const bareRaw = bare(raw);
  if (set.has(raw) || set.has(bareRaw)) return true;
  // Compare device-suffix-insensitive forms too (self chat id often ends in :34@lid).
  for (const id of set) {
    if (bare(String(id)) === bareRaw) return true;
  }
  // Never compare the numeric portion of an @lid to a phone number. Only PN JIDs
  // may use numeric equality as a fallback.
  if (isLid(raw)) return false;
  const n = numFromJid(raw);
  return !!n && set.has(n);
}

function aliases() { return new Map(knownAliases); }

module.exports = { isLid, isPn, buildMap, resolve, resolveWithSock, normalizeMany, normalizeManyWithSock, number, participantRecord, resolveIdentity, selfIds, isSelfJid, matchesAny, aliases };
