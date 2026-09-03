'use strict';

/**
 * Java (Minecraft / Microsoft account) cookie reader.
 *
 * Accepts a Netscape-format cookies .txt dump — the kind you export from a
 * browser (or a cookie editor) after signing into the Microsoft account that
 * owns the Minecraft Java Edition profile. The reference layout for these
 * files is the same one the Java-cookie (Microsoft account) Medal tooling
 * already consumes (e.g. `ravanwashere33g.txt`):
 *
 *     # Netscape HTTP Cookie File
 *     .login.live.com	TRUE	/	TRUE	1871153455	__Host-MSAAUTHP	11-M.C554_SN1...
 *     .live.com	TRUE	/	TRUE	1871153455	MUID	fc9aa049...
 *     ...
 *
 * This module does NOT authenticate anywhere. It only:
 *   1. Parses the file into cookie rows (skipping comments).
 *   2. Classifies the session so the caller knows what kind of Microsoft
 *      session it holds (live.com MSA artifacts, login.microsoftonline.com
 *      enterprise tokens, generic tracking cookies, …).
 *   3. Derives a human label (the Java in-game name hint comes from the file
 *      stem, e.g. `ravanwashere33g.txt` → `ravanwashere33g`).
 *
 * No secret values are ever emitted — only counts and domain names.
 */

const fs = require('fs');

// Cookie names that indicate a *usable* authenticated Microsoft session
// (as opposed to the analytics/tracking cookies that litter these exports).
const MSA_ARTIFACT_NAMES = new Set([
  '__Host-MSAAUTHP',
  'MSAAUTHP',
  'WLSSC',
  'MSCC',
  'MSPAuth',
  'MSPProf',
  'NAP',
]);
const LIVE_SESSION_HINTS = ['MUID', 'MSPCID', 'JSHP', 'PPLState', 'SDIDC'];

function stripHttpOnlyPrefix(domain) {
  // Cookies can be exported as "#HttpOnly_.live.com" — keep the domain.
  return domain.replace(/^#HttpOnly_/, '');
}

/**
 * Parse a Netscape cookie file into rows:
 *   { domain, includeSubdomains, path, secure, expires, name, value }
 */
function parseNetscapeCookieFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`cookie file not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue; // comments + header
    // Netscape format is strictly TAB separated (7 fields).
    const cols = trimmed.split('\t');
    if (cols.length < 7) {
      // Some exporters space-separate; don't fail the whole file on one row.
      continue;
    }
    rows.push({
      domain: stripHttpOnlyPrefix(cols[0]),
      includeSubdomains: cols[1].toLowerCase() === 'true',
      path: cols[2],
      secure: cols[3].toLowerCase() === 'true',
      expires: Number(cols[4]) || 0,
      name: cols[5],
      value: cols[6],
    });
  }
  return rows;
}

function domainsPresent(rows) {
  const seen = new Set();
  for (const r of rows) seen.add(r.domain.replace(/^\./, ''));
  return [...seen];
}

function countByPredicate(rows, names) {
  const set = names instanceof Set ? names : new Set(names);
  let n = 0;
  for (const r of rows) if (set.has(r.name)) n += 1;
  return n;
}

/**
 * Full inspection of one exported cookie file. Never throws on a bad file —
 * returns { ok:false, error } so the caller can log and skip to the next file.
 */
function loadJavaCookieInfo(filePath) {
  const fileBase = String(filePath).replace(/\\/g, '/').split('/').pop() || filePath;
  const stem = fileBase.replace(/\.(txt|json|bak)$/i, '');
  try {
    const rows = parseNetscapeCookieFile(filePath);
    if (rows.length === 0) {
      return {
        ok: false,
        path: filePath,
        fileName: fileBase,
        error: 'no cookie rows parsed (is this a Netscape-format export?)',
      };
    }
    const msaArtifacts = countByPredicate(rows, MSA_ARTIFACT_NAMES);
    const liveSessionHints = countByPredicate(rows, LIVE_SESSION_HINTS);
    const domains = domainsPresent(rows);
    const hasMsArtifact = rows.some(
      (r) => r.name === '__Host-MSAAUTHP' || r.name === 'MSAAUTHP'
    );
    const hasMicrosoftOnline = domains.includes('login.microsoftonline.com');
    const liveComAuthed = domains.includes('live.com') && msaArtifacts > 0;
    const looksLikeMsa = hasMsArtifact || (domains.includes('live.com') && liveSessionHints >= 2);

    return {
      ok: true,
      path: filePath,
      fileName: fileBase,
      ignHint: stem, // file stem is the operator's Java IGN convention
      cookieCount: rows.length,
      domains,
      hasMsArtifact,
      msaArtifactCount: msaArtifacts,
      liveSessionHintCount: liveSessionHints,
      hasMicrosoftOnline,
      liveComAuthed,
      looksLikeMsa,
      sessionLabel: hasMsArtifact
        ? 'MSA session artifact present'
        : liveComAuthed
        ? 'live.com session cookies present'
        : 'no obvious Microsoft auth cookies',
      // Whether this looks like something that can actually sign into the
      // Microsoft/Minecraft stack (vs. an empty/broken export).
      usable: hasMsArtifact || liveComAuthed,
    };
  } catch (e) {
    return { ok: false, path: filePath, fileName: fileBase, error: e.message };
  }
}

module.exports = { parseNetscapeCookieFile, loadJavaCookieInfo, MSA_ARTIFACT_NAMES };
