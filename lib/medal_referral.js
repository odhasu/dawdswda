'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { constants } = require('../medal_signup');

const { MEDAL_UA, MEDAL_API } = constants;

const resolveCache = new Map();

function baseHeaders(authHeader) {
  return {
    Accept: 'application/json',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'en-US',
    'Circuit-Breaker-Status': 'closed,11,0',
    Connection: 'keep-alive',
    'Content-Type': 'application/json',
    Host: 'medal.tv',
    'idempotency-key': `"${crypto.randomUUID()}"`,
    'Medal-User-Agent': MEDAL_UA,
    'User-Agent': MEDAL_UA,
    'X-Authentication': authHeader,
    'X-Timezone': 'Asia/Jakarta',
  };
}

async function resolveReferrerUserId(client, authHeader, username, opts = {}) {
  if (!username) throw new Error('resolveReferrerUserId: username is empty');
  const key = String(username).toLowerCase();
  if (resolveCache.has(key)) return resolveCache.get(key);

  const url = `${MEDAL_API}/search?q=${encodeURIComponent(username)}&collection=user&limit=5`;
  const r = await client.get(url, {
    headers: baseHeaders(authHeader),
    validateStatus: () => true,
  });
  if (r.status !== 200) {
    throw new Error(`search ${username} -> ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
  }
  // Response shape varies; try a few plausible keys.
  const data = r.data;
  let candidates =
    (data && (data.users || data.results || data.items || data.data)) || [];
  if (!Array.isArray(candidates) && data && typeof data === 'object') {
    // Some endpoints wrap as {collections:{user:{items:[...]}}}
    candidates =
      (data.collections && data.collections.user && data.collections.user.items) ||
      (data.user && data.user.items) ||
      [];
  }
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error(`search ${username}: no results`);
  }
  const first = candidates[0];
  const uid =
    first.userId ||
    first.id ||
    (first.user && (first.user.userId || first.user.id));
  if (!uid) {
    throw new Error(`search ${username}: first match has no userId: ${JSON.stringify(first).slice(0, 200)}`);
  }
  const sid = String(uid);
  resolveCache.set(key, sid);
  return sid;
}

async function applyReferral(client, authHeader, selfUserId, referringUserId, opts = {}) {
  if (!selfUserId) throw new Error('applyReferral: selfUserId is empty');
  if (!referringUserId) throw new Error('applyReferral: referringUserId is empty');
  const url = `${MEDAL_API}/users/${selfUserId}/referrals`;
  const r = await client.post(
    url,
    { referringUserId: String(referringUserId) },
    { headers: baseHeaders(authHeader), validateStatus: () => true }
  );
  if (r.status >= 200 && r.status < 300) {
    return { ok: true, status: r.status, data: r.data };
  }
  // Treat "already referred" / conflict as success.
  const body = typeof r.data === 'string' ? r.data : JSON.stringify(r.data || {});
  if (r.status === 409 || /already/i.test(body)) {
    return { ok: true, already: true, status: r.status, data: r.data };
  }
  throw new Error(`referral POST -> ${r.status}: ${body.slice(0, 240)}`);
}

function loadMedalUsernames(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`medalusername file not found: ${filePath}`);
  }
  const lines = fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (lines.length === 0) {
    throw new Error(`medalusername file is empty (after stripping comments): ${filePath}`);
  }
  return lines;
}

function pickRandomUsername(arr, rng = Math.random) {
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error('pickRandomUsername: empty array');
  }
  return arr[Math.floor(rng() * arr.length)];
}

module.exports = {
  resolveReferrerUserId,
  applyReferral,
  loadMedalUsernames,
  pickRandomUsername,
};
