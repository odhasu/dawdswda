'use strict';

const crypto = require('crypto');
const { URL } = require('url');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { constants } = require('../medal_signup');

const { MEDAL_UA, MEDAL_API } = constants;

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

class AuthorizationCookieExpiredError extends Error {
  constructor(msg) {
    super(msg || 'Roblox .ROBLOSECURITY cookie is expired or invalid');
    this.name = 'AuthorizationCookieExpiredError';
  }
}

class OAuthChallengeError extends Error {
  constructor(challengeType, msg) {
    super(msg || `Roblox OAuth challenge required: ${challengeType}`);
    this.name = 'OAuthChallengeError';
    this.challengeType = challengeType;
  }
}

class PlaywrightNotAvailableError extends Error {
  constructor(msg) {
    super(msg || 'playwright module is not installed');
    this.name = 'PlaywrightNotAvailableError';
  }
}

function proxyAgent(proxyUrl) {
  if (!proxyUrl) return null;
  if (proxyUrl.startsWith('socks')) return new SocksProxyAgent(proxyUrl);
  return new HttpsProxyAgent(proxyUrl);
}

function medalConnectHeaders(authHeader) {
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

async function requestRobloxConnection(client, authHeader, opts = {}) {
  const url = `${MEDAL_API}/connections`;
  const r = await client.post(
    url,
    { provider: 'roblox' },
    { headers: medalConnectHeaders(authHeader), validateStatus: () => true }
  );
  if (r.status !== 200 || !r.data || !r.data.loginUrl) {
    throw new Error(`POST /api/connections -> ${r.status}: ${JSON.stringify(r.data).slice(0, 240)}`);
  }
  return { callbackId: r.data.callbackId, loginUrl: r.data.loginUrl };
}

function parseLoginUrl(loginUrl) {
  const u = new URL(loginUrl);
  const q = u.searchParams;
  return {
    client_id: q.get('client_id') || q.get('client_key'),
    code_challenge: q.get('code_challenge'),
    code_challenge_method: q.get('code_challenge_method') || 'S256',
    state: q.get('state'),
    redirect_uri: q.get('redirect_uri'),
    scope: q.get('scope'),
    response_type: q.get('response_type') || 'code',
  };
}

function buildRobloxClient(proxy) {
  const agent = proxyAgent(proxy);
  return axios.create({
    timeout: 30_000,
    httpAgent: agent,
    httpsAgent: agent,
    validateStatus: () => true,
    maxRedirects: 0,
    headers: {
      'User-Agent': BROWSER_UA,
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
    },
  });
}

async function completeRobloxOAuth({ loginUrl, callbackId, robloxAccount, proxy, log }) {
  const _log = log || (() => {});
  const params = parseLoginUrl(loginUrl);
  if (!params.client_id || !params.code_challenge || !params.state) {
    throw new Error(`loginUrl missing oauth params: ${loginUrl}`);
  }

  const cookieHeader = robloxAccount.cookies;
  if (!cookieHeader) throw new Error('roblox account has no cookies');

  const http = buildRobloxClient(proxy);

  // 1. who am i
  const meRes = await http.get('https://users.roblox.com/v1/users/authenticated', {
    headers: {
      Cookie: cookieHeader,
      Accept: 'application/json',
    },
  });
  if (meRes.status === 401 || meRes.status === 403) {
    throw new AuthorizationCookieExpiredError(
      `users/authenticated -> ${meRes.status}: ${JSON.stringify(meRes.data).slice(0, 200)}`
    );
  }
  if (meRes.status !== 200 || !meRes.data || !meRes.data.id) {
    throw new Error(`users/authenticated -> ${meRes.status}: ${JSON.stringify(meRes.data).slice(0, 200)}`);
  }
  const robloxUserId = String(meRes.data.id);
  const robloxUsername = meRes.data.name;
  _log(`roblox: authed as ${robloxUsername} (${robloxUserId})`);

  // 2. provoke x-csrf-token
  const authzUrl = 'https://apis.roblox.com/oauth/v1/authorizations';
  const body = {
    clientId: params.client_id,
    codeChallenge: params.code_challenge,
    codeChallengeMethod: 'S256',
    redirectUri: params.redirect_uri || 'https://social-api.medal.tv/connections/callback',
    resourceInfos: [
      { owner: { id: robloxUserId, type: 'User' }, resources: { creator: { ids: ['U'] } } },
    ],
    responseTypes: ['Code'],
    scopes: [
      { scopeType: 'openid', operations: ['read'] },
      { scopeType: 'profile', operations: ['read'] },
      { scopeType: 'asset', operations: ['read'] },
      { scopeType: 'group', operations: ['read'] },
      { scopeType: 'user.inventory-item', operations: ['read'] },
    ],
    state: params.state,
  };

  const headersBase = {
    Cookie: cookieHeader,
    Accept: '*/*',
    'Content-Type': 'application/json-patch+json',
    Origin: 'https://authorize.roblox.com',
    Referer: 'https://authorize.roblox.com/',
    'sec-fetch-site': 'same-site',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
  };

  let csrf = null;
  const probe = await http.post(authzUrl, body, { headers: headersBase });
  if (probe.status === 403) {
    csrf = probe.headers['x-csrf-token'] || probe.headers['X-CSRF-TOKEN'];
    if (!csrf) {
      const challenge = probe.headers['rblx-challenge-type'];
      if (challenge) throw new OAuthChallengeError(challenge);
      throw new Error(`oauth probe 403 without x-csrf-token: ${JSON.stringify(probe.data).slice(0, 200)}`);
    }
  } else if (probe.status >= 200 && probe.status < 300) {
    // unlikely on first try but handle: treat probe response as actual result
    return await finalizeOAuth({ http, response: probe, callbackId, robloxUserId, robloxUsername, _log });
  } else {
    const challenge = probe.headers['rblx-challenge-type'];
    if (challenge) throw new OAuthChallengeError(challenge);
    throw new Error(`oauth probe -> ${probe.status}: ${JSON.stringify(probe.data).slice(0, 240)}`);
  }

  // 3. real authorization request
  const authRes = await http.post(authzUrl, body, {
    headers: { ...headersBase, 'x-csrf-token': csrf },
  });

  if (authRes.status < 200 || authRes.status >= 300) {
    const challenge = authRes.headers['rblx-challenge-type'];
    if (challenge) throw new OAuthChallengeError(challenge);
    throw new Error(`oauth authorize -> ${authRes.status}: ${JSON.stringify(authRes.data).slice(0, 240)}`);
  }

  return await finalizeOAuth({
    http,
    response: authRes,
    callbackId,
    robloxUserId,
    robloxUsername,
    _log,
  });
}

async function finalizeOAuth({ http, response, callbackId, robloxUserId, robloxUsername, _log }) {
  const data = response.data || {};
  let location = data.location || data.Location || response.headers['location'] || response.headers['Location'];
  if (!location) {
    throw new Error(`oauth authorize 200 but no location in body/header: ${JSON.stringify(data).slice(0, 200)}`);
  }
  _log(`roblox: oauth granted, hitting callback`);
  const cb = await http.get(location, {
    headers: { Accept: 'application/json,text/html;q=0.9,*/*;q=0.8' },
    validateStatus: () => true,
  });
  if (cb.status >= 400) {
    throw new Error(`callback ${location} -> ${cb.status}: ${String(cb.data).slice(0, 200)}`);
  }
  return {
    ok: true,
    robloxUserId,
    robloxUsername,
    callbackUrl: location,
    callbackStatus: cb.status,
    callbackId: callbackId || null,
  };
}

async function completeRobloxOAuthWithPlaywright({ loginUrl, robloxAccount, proxy, log }) {
  const _log = log || (() => {});
  let pw;
  try {
    pw = require('playwright');
  } catch (e) {
    throw new PlaywrightNotAvailableError(
      'playwright is not installed. Run `npm install playwright` then `npx playwright install chromium`.'
    );
  }

  const proxyOpt = (() => {
    if (!proxy) return undefined;
    try {
      const u = new URL(proxy);
      return {
        server: `${u.protocol}//${u.host}`,
        username: decodeURIComponent(u.username || '') || undefined,
        password: decodeURIComponent(u.password || '') || undefined,
      };
    } catch (_) {
      return { server: proxy };
    }
  })();

  const browser = await pw.chromium.launch({ headless: true, proxy: proxyOpt });
  let context;
  try {
    context = await browser.newContext({ userAgent: BROWSER_UA });
    const roblo = robloxAccount.roblosecurity;
    if (!roblo) throw new Error('roblox account has no .ROBLOSECURITY value');
    await context.addCookies([
      {
        name: '.ROBLOSECURITY',
        value: roblo,
        domain: '.roblox.com',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'None',
      },
    ]);
    const page = await context.newPage();
    _log('roblox(pw): goto loginUrl');
    await page.goto(loginUrl, { waitUntil: 'load', timeout: 60_000 });

    const btn = page.locator('button:has-text("Confirm and Give Access"), button.action-button').first();
    await btn.waitFor({ state: 'visible', timeout: 30_000 });
    _log('roblox(pw): clicking Confirm and Give Access');
    await btn.click();

    await page.waitForURL(
      (u) =>
        /social-api\.medal\.tv\/connections\/callback/.test(u.toString()) ||
        /medal\.tv\/auth\?status=success/.test(u.toString()),
      { timeout: 60_000 }
    );
    const finalUrl = page.url();
    _log(`roblox(pw): landed at ${finalUrl}`);
    return { ok: true, callbackUrl: finalUrl };
  } finally {
    try { if (context) await context.close(); } catch (_) {}
    try { await browser.close(); } catch (_) {}
  }
}

module.exports = {
  requestRobloxConnection,
  completeRobloxOAuth,
  completeRobloxOAuthWithPlaywright,
  AuthorizationCookieExpiredError,
  OAuthChallengeError,
  PlaywrightNotAvailableError,
};
