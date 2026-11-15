// features/roles.js — runtime role management layered on top of the static .env
// owner. Supports addowner / addadmin / addsudo at runtime (persisted to disk via
// the db Collection, so it survives restarts).
//
// Hierarchy (highest to lowest): owner > sudo > admin > group-admin > member.
const { Collection } = require('../db');
const { numFromJid } = require('../utils/helpers');
const config = require('../config');

const store = new Collection('roles', { owners: [], sudo: [], admins: [] });

function _norm(jidOrNum) {
  return String(jidOrNum || '').split('@')[0].split(':')[0];
}

/** Digits-only phone variants so 2340812… and 234812… both match WhatsApp JIDs. */
function phoneVariants(jidOrNum) {
  const raw = _norm(jidOrNum);
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return [];
  const set = new Set([digits, raw]);
  // Strip leading zeros after country-style prefixes users often paste wrong
  // e.g. 2340XXXXXXXXX → 234XXXXXXXXX, 0XXXXXXXXXX → XXXXXXXXXX
  if (digits.startsWith('2340') && digits.length >= 14) set.add('234' + digits.slice(4));
  if (digits.startsWith('0') && digits.length >= 10) set.add(digits.slice(1));
  if (digits.startsWith('234') && digits.length >= 13) set.add(digits.slice(3)); // national
  // Last 10 / 11 / 12 digits (common WA local forms)
  for (const n of [10, 11, 12, 13]) {
    if (digits.length >= n) set.add(digits.slice(-n));
  }
  return [...set].filter(Boolean);
}

function phonesMatch(a, b) {
  const A = phoneVariants(a);
  const B = new Set(phoneVariants(b));
  if (!A.length || !B.size) return false;
  return A.some((x) => B.has(x));
}

function all() {
  return store.get('roles', { owners: [], sudo: [], admins: [] });
}
function save(r) {
  store.set('roles', r);
}

// --- getters ---
function isStaticOwner(num) {
  const owners = config.ownerIds || [];
  if (!owners.length) return false;
  return owners.some((o) => phonesMatch(o, num));
}
function isOwner(jidOrNum) {
  const candidates = Array.isArray(jidOrNum) ? jidOrNum : [jidOrNum];
  const r = all();
  for (const c of candidates) {
    if (!c) continue;
    if (isStaticOwner(c)) return true;
    if ((r.owners || []).some((o) => phonesMatch(o, c))) return true;
  }
  return false;
}
function isOwnerAny(list) { return isOwner(list); }
function isSudo(jidOrNum) {
  if (isOwner(jidOrNum)) return true;
  const r = all();
  return (r.sudo || []).some((o) => phonesMatch(o, jidOrNum));
}
function isAdmin(jidOrNum) {
  if (isSudo(jidOrNum)) return true;
  const r = all();
  return (r.admins || []).some((o) => phonesMatch(o, jidOrNum));
}
// --- mutators (all guarded by caller checking isOwner) ---
function addOwner(jidOrNum) {
  const r = all();
  for (const n of phoneVariants(jidOrNum)) {
    if (n && !r.owners.includes(n)) r.owners.push(n);
  }
  const primary = _norm(jidOrNum);
  if (primary && !r.owners.includes(primary)) r.owners.push(primary);
  save(r);
  return primary;
}
function removeOwner(jidOrNum) {
  const n = _norm(jidOrNum);
  if (isStaticOwner(n)) return null; // can't remove a .env owner
  const r = all();
  r.owners = r.owners.filter((x) => x !== n);
  r.sudo = r.sudo.filter((x) => x !== n);
  r.admins = r.admins.filter((x) => x !== n);
  save(r);
  return n;
}
function addSudo(jidOrNum) {
  const n = _norm(jidOrNum);
  const r = all();
  if (!r.sudo.includes(n)) r.sudo.push(n);
  save(r);
  return n;
}
function removeSudo(jidOrNum) {
  const n = _norm(jidOrNum);
  const r = all();
  r.sudo = r.sudo.filter((x) => x !== n);
  save(r);
  return n;
}
function addAdmin(jidOrNum) {
  const n = _norm(jidOrNum);
  const r = all();
  if (!r.admins.includes(n)) r.admins.push(n);
  save(r);
  return n;
}
function removeAdmin(jidOrNum) {
  const n = _norm(jidOrNum);
  const r = all();
  r.admins = r.admins.filter((x) => x !== n);
  save(r);
  return n;
}

function list() {
  const r = all();
  return {
    owners: r.owners,
    sudo: r.sudo,
    admins: r.admins,
    staticOwners: config.ownerIds,
  };
}

module.exports = {
  isOwner, isSudo, isAdmin, isStaticOwner,
  addOwner, removeOwner, addSudo, removeSudo, addAdmin, removeAdmin,
  list,
};
