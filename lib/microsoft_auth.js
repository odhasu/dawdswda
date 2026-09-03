'use strict';

/**
 * Microsoft / Minecraft (MSA) account integration — PLACEHOLDER STUB.
 *
 * NOT wired into medal_signup.js yet. The DonutSMP flow currently connects the
 * reward to a Java (Minecraft/Microsoft) account by having the operator export
 * their signed-in Microsoft session as a Netscape cookie .txt and drop it into
 * java_cookies/ (see lib/java_cookie.js). This module is reserved for a future
 * full MSA re-auth flow (cookie refresh -> Xbox Live -> XSTS -> Minecraft auth)
 * so the bot could mint its own session instead of consuming an exported one.
 *
 * Only the cookie-file parser below is implemented; the auth steps throw.
 */

const fs = require('fs');

/**
 * Parse a Netscape-format cookie dump (as exported from a cookie editor /
 * devtools after signing into login.live.com / microsoftonline.com) into
 * [{ domain, includeSubdomains, path, secure, expires, name, value }].
 *
 * The reference layout is the same as lib/java_cookie.js consumes:
 *
 *     # Netscape HTTP Cookie File
 *     .login.live.com	TRUE	/	TRUE	1871153455	__Host-MSAAUTHP	11-M.C540_...
 *     login.live.com	FALSE	/	TRUE	1871153455	MSPAuth	...
 *
 * Rows that are not TAB-separated (broken exporters, stray fragments) are
 * skipped rather than failing the whole file.
 */
function parseNetscapeCookies(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`cookie file not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue; // comments + header
    const cols = trimmed.split('\t');
    if (cols.length < 7) continue;
    rows.push({
      domain: cols[0].replace(/^#HttpOnly_/, ''),
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

function notImplemented(name) {
  return function () {
    throw new Error(`${name} is not implemented yet (Microsoft auth stub)`);
  };
}

/**
 * Refresh an MSA session cookie / token from the exported artifacts.
 * Reserved for future use — see module header.
 */
const refreshMsaToken = notImplemented('refreshMsaToken');

/**
 * Exchange an MSA token for an Xbox Live token (user.auth.xboxlive.com).
 * Reserved for future use — see module header.
 */
const xboxAuthenticate = notImplemented('xboxAuthenticate');

module.exports = { parseNetscapeCookies, refreshMsaToken, xboxAuthenticate };
