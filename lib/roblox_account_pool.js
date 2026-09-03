'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_ACCOUNTS_PATH = '/root/Roblox-Account-Creator/output/accounts.txt';
const DEFAULT_JOINED_PATH   = '/root/Roblox-Account-Creator/output/joined.txt';
const DEFAULT_STATE_PATH    = '/root/medalbot/roblox_quest_progress.json';

function loadJoinedUsernames(filePath) {
  // Reads the Roblox-Account-Creator's joined.txt — one username per line,
  // representing accounts that have actually joined the Medal TV community
  // group. Returns a Set for O(1) membership tests. Missing file → null
  // (caller decides whether to fall back to unfiltered or refuse to run).
  if (!filePath || !fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf8');
  const out = new Set();
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    out.add(t);
  }
  return out;
}

function extractRoblosecurity(cookies) {
  if (!cookies) return null;
  const parts = String(cookies).split(';').map((p) => p.trim());
  for (const p of parts) {
    if (p.startsWith('.ROBLOSECURITY=')) {
      return p.slice('.ROBLOSECURITY='.length);
    }
  }
  return null;
}

function loadRobloxAccounts(filePath = DEFAULT_ACCOUNTS_PATH) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`roblox accounts file not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    // username:password:cookies — but the cookies field itself may contain
    // ':' (e.g. inside cookie values). Split on the FIRST two colons.
    const firstColon = t.indexOf(':');
    if (firstColon < 0) continue;
    const secondColon = t.indexOf(':', firstColon + 1);
    if (secondColon < 0) continue;
    const username = t.slice(0, firstColon);
    const password = t.slice(firstColon + 1, secondColon);
    const cookies = t.slice(secondColon + 1);
    const roblosecurity = extractRoblosecurity(cookies);
    if (!roblosecurity) continue;
    out.push({ username, password, cookies, roblosecurity });
  }
  return out;
}

function atomicWriteJson(filePath, obj) {
  const tmp = filePath + '.tmp';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function loadState(statePath) {
  if (!fs.existsSync(statePath)) return { used: {}, paired: {} };
  try {
    const data = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return {
      used: data.used || {},
      paired: data.paired || {},
    };
  } catch (_) {
    return { used: {}, paired: {} };
  }
}

class RobloxAccountPool {
  constructor({ accountsPath, statePath, joinedPath, requireJoined = true } = {}) {
    this.accountsPath = accountsPath || DEFAULT_ACCOUNTS_PATH;
    this.statePath = statePath || DEFAULT_STATE_PATH;
    // joinedPath = null disables the filter (use ALL accounts.txt entries).
    // Otherwise we treat joined.txt as a hard allowlist: only accounts whose
    // Roblox username appears in joined.txt are eligible, because Medal's
    // claim endpoint requires the "Join the Medal TV group on Roblox" task
    // to be completed. Without the join, claim returns errorId 62.
    this.joinedPath = joinedPath === null ? null : (joinedPath || DEFAULT_JOINED_PATH);
    const allAccounts = loadRobloxAccounts(this.accountsPath);
    const joined = this.joinedPath ? loadJoinedUsernames(this.joinedPath) : null;
    this.joinedSet = joined;
    if (joined !== null) {
      this.accounts = allAccounts.filter((a) => joined.has(a.username));
      this.totalBeforeJoinFilter = allAccounts.length;
      if (this.accounts.length === 0 && requireJoined) {
        throw new Error(
          `roblox pool: 0 accounts pass the joined.txt filter (${this.joinedPath}). ` +
          `Either run join_group.py to populate joined.txt, or pass --no-joined-filter ` +
          `to use accounts.txt unfiltered.`
        );
      }
    } else {
      this.accounts = allAccounts;
      this.totalBeforeJoinFilter = allAccounts.length;
    }
    this.state = loadState(this.statePath);
    // In-memory leases: reserved the moment a worker calls lease(), before
    // markPaired() persists to disk. Prevents concurrent workers from picking
    // the same Roblox account during the long Medal signup window.
    this._leased = new Set();
    this._opChain = Promise.resolve();
    this._writeChain = Promise.resolve();
  }

  _runExclusive(fn) {
    const next = this._opChain.then(() => fn(), () => fn());
    this._opChain = next.catch(() => {});
    return next;
  }

  /** Count of joined accounts not yet used or leased. */
  availableCount() {
    return this.accounts.filter(
      (a) => !this.state.used[a.username] && !this._leased.has(a.username)
    ).length;
  }

  /** Atomically reserve the next unused Roblox account. */
  async lease() {
    return this._runExclusive(async () => {
      for (const acct of this.accounts) {
        if (!this.state.used[acct.username] && !this._leased.has(acct.username)) {
          this._leased.add(acct.username);
          return acct;
        }
      }
      return null;
    });
  }

  /** Return a lease without marking the account permanently used (pipeline failed). */
  async releaseLease(robloxUsername) {
    if (!robloxUsername) return;
    return this._runExclusive(async () => {
      this._leased.delete(robloxUsername);
    });
  }

  /** @deprecated use lease() — kept for callers that haven't migrated yet */
  next() {
    for (const acct of this.accounts) {
      if (!this.state.used[acct.username] && !this._leased.has(acct.username)) {
        this._leased.add(acct.username);
        return acct;
      }
    }
    return null;
  }

  _persist() {
    const snapshot = {
      used: { ...this.state.used },
      paired: { ...this.state.paired },
    };
    this._writeChain = this._writeChain.then(() => {
      atomicWriteJson(this.statePath, snapshot);
    });
    return this._writeChain;
  }

  async markPaired(robloxUsername, medalUserId) {
    return this._runExclusive(async () => {
      this._leased.delete(robloxUsername);
      this.state.used[robloxUsername] = {
        medalUserId: String(medalUserId),
        usedAt: new Date().toISOString(),
      };
      this.state.paired[String(medalUserId)] = robloxUsername;
      await this._persist();
    });
  }

  getRoblox(medalUserId) {
    const u = this.state.paired[String(medalUserId)];
    if (!u) return null;
    return this.accounts.find((a) => a.username === u) || null;
  }
}

module.exports = {
  loadRobloxAccounts,
  loadJoinedUsernames,
  RobloxAccountPool,
  DEFAULT_ACCOUNTS_PATH,
  DEFAULT_JOINED_PATH,
  DEFAULT_STATE_PATH,
};
