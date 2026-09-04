'use strict';

/**
 * Minecraft Java token minting from Microsoft "Live" session cookies.
 *
 * Replicates the mc-bedrock-generator method, but skips prismarine-auth's
 * title-token step (which 403s for the Java flow) and does the standard
 * wiki.vg sequence directly:
 *
 *   MSA cookie OAuth -> MSA access_token
 *     -> exchangeRpsTicketForUserToken  (user.auth.xboxlive.com)
 *     -> exchangeUserTokenForXSTSIdentity (xsts, rp://api.minecraftservices.com/)
 *     -> login_with_xbox (api.minecraftservices.com)
 *     -> Minecraft profile (name + uuid)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { exchangeRpsTicketForUserToken, exchangeUserTokenForXSTSIdentity } = require('@xboxreplay/xboxlive-auth');
const { parseNetscapeCookieFile } = require('./java_cookie');

const SCOPE = 'service::user.auth.xboxlive.com::MBI_SSL';
const REDIRECT_URI = 'https://login.live.com/oauth20_desktop.srf';
const MINECRAFT_CLIENT_ID = '00000000402b5328'; // Titles.MinecraftJava
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function proxyAgent(proxyUrl) {
  if (!proxyUrl) return null;
  if (String(proxyUrl).startsWith('socks')) {
    const { SocksProxyAgent } = require('socks-proxy-agent');
    return new SocksProxyAgent(proxyUrl);
  }
  const { HttpsProxyAgent } = require('https-proxy-agent');
  return new HttpsProxyAgent(proxyUrl);
}

function buildCookieJar(rows) {
  return rows.map((r) => `${r.name}=${r.value}`).join('; ');
}

function getFlowToken(html) {
  let m = html.match(/value=\\"([^\\"]+)\\"/);
  if (m) return m[1];
  m = html.match(/"sFT"\s*:\s*"([^"]+)"/);
  if (m) return m[1];
  m = html.match(/sFT\s*[:=]\s*'([^']+)'/);
  if (m) return m[1];
  m = html.match(/name="PPFT"[^>]*value="([^"]+)"/);
  if (m) return m[1];
  return null;
}

function getUrlPost(html) {
  let m = html.match(/"urlPost"\s*:\s*"([^"]+)"/);
  if (m) return m[1];
  m = html.match(/urlPost\s*[:=]\s*'([^']+)'/);
  if (m) return m[1];
  m = html.match(/urlPost\s*[:=]\s*"([^"]+)"/);
  if (m) return m[1];
  m = html.match(/<form[^>]*action="([^"]+)"/);
  if (m) return m[1] && m[1].replace(/&amp;/g, '&');
  return null;
}

/**
 * Drive the cookie-based Microsoft OAuth to get an MSA access_token.
 */
async function getMsaAccessToken(cookieFile, proxy) {
  const rows = parseNetscapeCookieFile(cookieFile);
  if (rows.length === 0) throw new Error(`no cookies parsed from ${cookieFile}`);
  const cookieHeader = buildCookieJar(rows);
  const agent = proxyAgent(proxy);
  const axOpts = agent ? { httpAgent: agent, httpsAgent: agent, proxy: false } : {};

  const authorizeUrl =
    `https://login.live.com/oauth20_authorize.srf?client_id=${MINECRAFT_CLIENT_ID}` +
    `&scope=${encodeURIComponent(SCOPE)}&response_type=code` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&display=touch&locale=en`;

  let res = await axios.get(authorizeUrl, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.5', Cookie: cookieHeader },
    ...axOpts, maxRedirects: 0, validateStatus: () => true, timeout: 30000,
  });

  let code = null;
  let url = authorizeUrl;
  for (let hop = 0; hop < 25 && !code; hop++) {
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.location;
      if (!loc) break;
      url = new URL(loc, url).href;
      if (url.startsWith(REDIRECT_URI)) { code = new URL(url).searchParams.get('code'); break; }
      res = await withRetry(() => axios.get(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.5', Cookie: cookieHeader },
        ...axOpts, maxRedirects: 0, validateStatus: () => true, timeout: 30000,
      }));
      continue;
    }

    if (res.status !== 200) break;
    const body = typeof res.data === 'string' ? res.data : '';

    if (body.length < 20000 && body.includes('DoSubmit')) {
      const formUrl = getUrlPost(body);
      if (formUrl) {
        const sFT = getFlowToken(body) || '';
        const postBody = new URLSearchParams({ login: '', passwd: '', PPFT: sFT }).toString();
        res = await withRetry(() => axios.post(formUrl, postBody, {
          headers: {
            'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded',
            'Accept-Language': 'en-US,en;q=0.5', Cookie: cookieHeader, Referer: url,
          },
          ...axOpts, maxRedirects: 0, validateStatus: () => true, timeout: 30000,
        }));
        url = formUrl;
        continue;
      }
    }

    try {
      const parsed = new URL(url);
      if (parsed.hostname.includes('privacynotice')) {
        const ru = parsed.searchParams.get('ru');
        if (ru) { url = ru; res = await withRetry(() => axios.get(url, { headers: { 'User-Agent': UA, Cookie: cookieHeader }, ...axOpts, maxRedirects: 0, validateStatus: () => true, timeout: 30000 })); continue; }
      }
    } catch (_) { /* fall through */ }

    break;
  }

  if (!code) throw new Error(`OAuth did not produce a code (stuck at ${url}). Cookie session may be expired.`);

  const tokenBody = new URLSearchParams({
    client_id: MINECRAFT_CLIENT_ID,
    code,
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
  });
  const tokenRes = await axios.post('https://login.live.com/oauth20_token.srf', tokenBody.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    ...axOpts, timeout: 15000,
  });
  const tokens = tokenRes.data;
  if (!tokens.access_token) throw new Error(`token exchange failed: ${JSON.stringify(tokens).slice(0, 300)}`);
  return tokens.access_token;
}

// Retry a request on transient socket errors (EADDRINUSE, resets, timeouts).
async function withRetry(fn, retries = 3) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < retries - 1 && /EADDRINUSE|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/.test(String(e.message || ''))) {
        await new Promise((r) => setTimeout(r, 400 * (i + 1)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

/**
 * Follow a Microsoft OAuth URL (client_id + redirect_uri already baked in)
 * using the exported MSA cookies — no browser. Handles redirects, consent
 * auto-submit and privacy notices. Returns the final URL reached.
 */
async function followMicrosoftOauth(startUrl, cookieFile, proxy) {
  const rows = parseNetscapeCookieFile(cookieFile);
  if (rows.length === 0) throw new Error(`no cookies parsed from ${cookieFile}`);
  const cookieHeader = buildCookieJar(rows);
  const agent = proxyAgent(proxy);
  const axOpts = agent ? { httpAgent: agent, httpsAgent: agent, proxy: false } : {};

  // Microsoft sometimes drops client_id mid-redirect; keep it to re-add.
  let baseClientId = null;
  try { baseClientId = new URL(startUrl).searchParams.get('client_id'); } catch (_) {}

  let url = startUrl;
  let res = await withRetry(() => axios.get(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.5', Cookie: cookieHeader },
    ...axOpts, maxRedirects: 0, validateStatus: () => true, timeout: 30000,
  }));

  for (let hop = 0; hop < 25; hop++) {
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.location;
      if (!loc) break;
      url = new URL(loc, url).href;
      // Medal's callback lands on medal.tv/auth?status=... — terminal.
      if (/medal\.tv\/auth[?]/.test(url)) break;
      // Re-add client_id if a Microsoft redirect dropped it.
      if (baseClientId) {
        try {
          const u = new URL(url);
          if ((u.hostname.endsWith('live.com') || u.hostname.endsWith('microsoftonline.com')) && !u.searchParams.get('client_id')) {
            u.searchParams.set('client_id', baseClientId);
            url = u.href;
          }
        } catch (_) {}
      }
      res = await withRetry(() => axios.get(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.5', Cookie: cookieHeader },
        ...axOpts, maxRedirects: 0, validateStatus: () => true, timeout: 30000,
      }));
      continue;
    }

    if (res.status !== 200) break;
    const body = typeof res.data === 'string' ? res.data : '';

    if (body.length < 20000 && body.includes('DoSubmit')) {
      const formUrl = getUrlPost(body);
      if (formUrl) {
        const sFT = getFlowToken(body) || '';
        const postBody = new URLSearchParams({ login: '', passwd: '', PPFT: sFT }).toString();
        res = await withRetry(() => axios.post(formUrl, postBody, {
          headers: {
            'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded',
            'Accept-Language': 'en-US,en;q=0.5', Cookie: cookieHeader, Referer: url,
          },
          ...axOpts, maxRedirects: 0, validateStatus: () => true, timeout: 30000,
        }));
        url = formUrl;
        continue;
      }
    }

    try {
      const parsed = new URL(url);
      if (parsed.hostname.includes('privacynotice')) {
        const ru = parsed.searchParams.get('ru');
        if (ru) { url = ru; res = await withRetry(() => axios.get(url, { headers: { 'User-Agent': UA, Cookie: cookieHeader }, ...axOpts, maxRedirects: 0, validateStatus: () => true, timeout: 30000 })); continue; }
      }
    } catch (_) { /* fall through */ }

    break;
  }

  return url;
}

/**
 * Drive the Medal Microsoft link OAuth over HTTP cookies (no browser).
 * Returns { finalUrl, status, errorCode, message }.
 */
async function linkMedalViaCookies(cookieFile, loginUrl, proxy) {
  const finalUrl = await followMicrosoftOauth(loginUrl, cookieFile, proxy);
  let status = null, errorCode = null, message = null;
  try {
    const u = new URL(finalUrl);
    status = u.searchParams.get('status');
    errorCode = u.searchParams.get('errorCode');
    message = u.searchParams.get('message');
  } catch (_) { /* not a URL */ }
  return { finalUrl, status, errorCode, message };
}

const toDER = (pem) =>
  pem
    .split('\n')
    .slice(1, -1)
    .reduce((acc, cur) => Buffer.concat([acc, Buffer.from(cur, 'base64')]), Buffer.alloc(0));

/**
 * Fetch the Minecraft profile keypair (for chat signing in 1.19+).
 * Returns the `profileKeys` object minecraft-protocol expects.
 */
async function fetchProfileKeys(accessToken) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': 'MinecraftLauncher/2.2.10675',
  };
  const cert = (await axios.post('https://api.minecraftservices.com/player/certificates', {}, {
    headers, timeout: 15000,
  })).data;
  const profileKeys = {
    publicPEM: cert.keyPair.publicKey,
    privatePEM: cert.keyPair.privateKey,
    publicDER: toDER(cert.keyPair.publicKey),
    privateDER: toDER(cert.keyPair.privateKey),
    signature: Buffer.from(cert.publicKeySignature, 'base64'),
    signatureV2: Buffer.from(cert.publicKeySignatureV2, 'base64'),
    expiresOn: new Date(cert.expiresAt),
    refreshAfter: new Date(cert.refreshedAfter),
  };
  profileKeys.public = crypto.createPublicKey({ key: profileKeys.publicDER, format: 'der', type: 'spki' });
  profileKeys.private = crypto.createPrivateKey({ key: profileKeys.privateDER, format: 'der', type: 'pkcs8' });
  return profileKeys;
}

/**
 * Mint a Minecraft Java token (SSID) from an exported MSA cookie file.
 * Returns { token, username, uuid, profileKeys }.
 */
async function mintMinecraftToken({ cookieFile, proxy = null }) {
  // 1. MSA access token from cookies
  const msaAccessToken = await getMsaAccessToken(cookieFile, proxy);

  // 2. Xbox Live user token
  const rps = await exchangeRpsTicketForUserToken('t=' + msaAccessToken);
  const userToken = rps.Token;

  // 3. XSTS token for Minecraft services
  const xsts = await exchangeUserTokenForXSTSIdentity(userToken, {
    XSTSRelyingParty: 'rp://api.minecraftservices.com/',
  });

  // 4. Minecraft access token (SSID)
  const loginRes = await axios.post('https://api.minecraftservices.com/authentication/login_with_xbox', {
    identityToken: `XBL3.0 x=${xsts.userHash};${xsts.XSTSToken}`,
  }, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
  const mcToken = loginRes.data.access_token;
  if (!mcToken) throw new Error(`login_with_xbox failed: ${JSON.stringify(loginRes.data).slice(0, 300)}`);

  // 5. Minecraft profile (username + uuid)
  const profileRes = await axios.get('https://api.minecraftservices.com/minecraft/profile', {
    headers: { Authorization: `Bearer ${mcToken}` },
    timeout: 15000,
  });
  const profile = profileRes.data;

  // 6. Profile keypair for chat signing (1.19+ servers kick unsigned chat).
  let profileKeys = null;
  try {
    profileKeys = await fetchProfileKeys(mcToken);
  } catch (e) {
    // Non-fatal — chat signing just won't work if this fails.
    console.error(`[auth] profile keys fetch failed: ${e.message}`);
  }

  return {
    token: mcToken,
    username: (profile && profile.name) || null,
    uuid: (profile && profile.id) || null,
    profileKeys,
  };
}

module.exports = { mintMinecraftToken, followMicrosoftOauth, linkMedalViaCookies, SCOPE, REDIRECT_URI };
