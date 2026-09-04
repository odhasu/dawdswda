#!/usr/bin/env node
/**
 * Medal.tv signup bot (Node.js port).
 *
 * Replays the exact HTTP flow the Medal-Electron client uses when a user
 * creates an account through the "Create Medal Account" form:
 *
 *   1. onboardingStarted / onboarding analytics  -> ampltd2.medal.tv
 *   2. POST /api/users/email                      (availability check)
 *   3. POST /api/users/username                   (availability check)
 *   4. POST /api/authentication/password          (strength check)
 *   5. Solve hCaptcha via OnyxSolver
 *   6. POST /api/users                            (actual account creation)
 *   7. POST /api/authentication/sync              (session token)
 *   8. GET  /api/users/<id>/referrals             (cosmetic - 404 expected)
 *   9. POST firestore-auth.medal.tv/http/authenticate
 *  10. Final onboarding/$identify analytics batches
 *
 * Successful accounts are appended to accounts.jsonl.
 *
 * Java-cookie mode (Microsoft/Minecraft identities exported as MSA cookie .txt
 * files in java_cookies/ — one Microsoft account can be used at most once):
 *   node medal_signup.js --java-cookie ./java_cookies       # whole directory
 *   node medal_signup.js --java-cookie ./java_cookies/acct.txt   # single cookie
 *     Per account: signup -> 5sim phone verify -> try exported MSA cookies
 *     until one links this Medal account (bad/dead cookies drop out to
 *     bad_java_cookies.jsonl) -> enroll DonutSMP quest -> clip upload/post ->
 *     STOP. The reward is redeemed in-game as the linked Java account; no
 *     claim is ever submitted by the bot.
 *
 * Generic:
 *   node medal_signup.js --count 10      # N accounts in a loop
 *   node medal_signup.js --proxy user:pass@host:port
 *   node medal_signup.js --no-analytics  # skip amplitude/firestore calls
 *   node medal_signup.js --verify-phone  # buy a number on 5sim.net, submit phone,
 *                                        # wait for SMS, submit code (requires
 *                                        # FIVESIM_API_KEY in .env)
 *   node medal_signup.js --quest-id 2pQLGqBjtd   # override quest enrollment target
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { AsyncLocalStorage } = require('node:async_hooks');
const crc32c = require('fast-crc32c');

const { FiveSim } = require('./lib/sms5sim');
const { loadJavaCookieInfo, parseNetscapeCookieFile } = require('./lib/java_cookie');
const { redeemMedal } = require('./lib/redeem');

// Per-worker context: when set, log() prefixes its output with the worker tag.
// Unset (top-level / sequential mode) → log() behaves exactly as before.
const workerContext = new AsyncLocalStorage();

require('dotenv').config({ path: path.join(__dirname, '.env') });

// --------------------------------------------------------------------------
// Constants taken verbatim from the captured Medal-Electron traffic.
// --------------------------------------------------------------------------
const MEDAL_UA =
  'Medal-Electron/2617.143.1 (string_id_v2; simplified_signup; no_upscale; ' +
  'markdown; new_discord_guilds; ACHIEVEMENT_QUESTS; feed_reason_v2; ' +
  'instrumentation_2025_08_20) win32/10.0.26200 (x64; AMD Radeon RX 7600) ' +
  'Electron/40.1.0 Recorder/2617.1468.1 Node/24.11.1 Chrome/144.0.7559.96 ' +
  'Environment/production';

const AMPLITUDE_UA_BROWSER =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, ' +
  'like Gecko) Medal/2617.143.1 Chrome/144.0.7559.96 Electron/40.1.0 ' +
  'Safari/537.36';

const AMPLITUDE_API_KEY = '68186c87b60ddd1c4a29e7be15fa7d7f';
const APP_VERSION = '2617.143.1';
const RECORDER_VERSION = '2617.1468.1';
const ELECTRON_VERSION_NUM = 11239938785281;
const RECORDER_VERSION_NUM = 11240025620481;

const MEDAL_API = 'https://medal.tv/api';
const MEDAL_V2_API = 'https://api-v2.medal.tv';
const AMPLITUDE_URL = 'https://ampltd2.medal.tv/2/httpapi';
const FIRESTORE_AUTH_URL = 'https://firestore-auth.medal.tv/http/authenticate';
const ONYX_BASE    = 'https://onyxsolver.io';
const CAPLESS_BASE = 'https://capless.lol';
const NOPECHA_BASE = 'https://api.nopecha.com';
const REZO_BASE    = 'https://rezosolver.com';
const VOID_BASE    = 'https://api.voidsolver.tech';

// From Medal's init_constants$1:
//   CONTENT_TYPES = { CLIP:15, UPLOAD:21, MONTAGE:23, ... }
const CONTENT_TYPE_CLIP = 15;
const CONTENT_TYPE_UPLOAD = 21;
//   PRIVACY_ENUM = { PUBLIC:0, UNLISTED:1, PRIVATE:2, SAVED_TO_LIBRARY:3, ... }
const PRIVACY_PUBLIC = 0;
const PRIVACY_UNLISTED = 1;
// Minecraft category
const MINECRAFT_CATEGORY_ID = 'hAXdelx2t';

// --------------------------------------------------------------------------

// --------------------------------------------------------------------------
// CLI args
// --------------------------------------------------------------------------
function parseArgs(argv) {
  const args = {
    count: 1,
    proxy: null,
    analytics: true,
    debugHcaptcha: false,
    captureFile: null,
    verifyPhone: false,
    enrollQuest: true,
    questId: null,
    uploadClip: false,
    clipPath: null,
    verbose: false,
    javaCookie: null, // path to ONE Microsoft/Minecraft cookie .txt OR a directory
    javaRelink: false, // retry the MS link on saved verified-but-unlinked accounts
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--count' || a === '-n') {
      args.count = parseInt(argv[++i], 10) || 1;
    } else if (a === '--proxy' || a === '-p') {
      args.proxy = argv[++i];
    } else if (a === '--no-analytics') {
      args.analytics = false;
    } else if (a === '--debug-hcaptcha') {
      args.debugHcaptcha = true;
    } else if (a === '--capture-file') {
      args.captureFile = argv[++i];
    } else if (a === '--verify-phone') {
      args.verifyPhone = true;
    } else if (a === '--no-verify-phone') {
      args.verifyPhone = false;
    } else if (a === '--no-enroll-quest') {
      args.enrollQuest = false;
    } else if (a === '--quest-id') {
      args.questId = argv[++i];
    } else if (a === '--upload-clip') {
      args.uploadClip = true;
    } else if (a === '--clip-path') {
      args.clipPath = argv[++i];
      args.uploadClip = true;
    } else if (a === '--java-cookie' || a === '-j') {
      args.javaCookie = argv[++i];
    } else if (a === '--java-relink') {
      args.javaRelink = true;
    } else if (a === '--verbose' || a === '-v') {
      args.verbose = true;
    } else if (a === '-h' || a === '--help') {
      console.log(
        'Usage: node medal_signup.js [options]\n' +
          '\n' +
          'Java-cookie mode (MSA cookie -> one linked Medal account):\n' +
          '  --java-cookie <file-or-dir>   a Netscape-format cookie .txt for one\n' +
          '                                 Microsoft/Minecraft identity, or a directory\n' +
          '                                 of them. Per account the bot: signup -> phone\n' +
          '                                 verify -> try cookies until one links this\n' +
          '                                 account -> enroll quest -> clip upload/post ->\n' +
          '                                 STOP. Dead cookies are dropped to\n' +
          '                                 bad_java_cookies.jsonl. It never submits a\n' +
          '                                 quest claim; you redeem the reward in-game\n' +
          '                                 as the linked Minecraft account.\n' +
          '                                 Default cookie dir: ./java_cookies\n' +
          '  --java-relink                  instead of signing up new accounts, retry the\n' +
          '                                 Microsoft/Minecraft link for accounts already\n' +
          '                                 saved in accounts.jsonl as phone-verified but\n' +
          '                                 unlinked (linkPending). No new signup / phone.\n' +
          '\n' +
          'Generic options:\n' +
          '  --count N                     create N accounts in a loop (default 1)\n' +
          '  --proxy user:pass@host:port   tunnel requests through this proxy\n' +
          '  --verify-phone                verify the phone via 5sim.net (FIVESIM_API_KEY)\n' +
          '  --no-enroll-quest             skip quest enrollment after signup\n' +
          '  --quest-id <id>               override quest enrollment target\n' +
          '  --upload-clip / --clip-path <file>\n' +
          '                                 upload + post a clip (posts PUBLIC to profile)\n' +
          '  --no-analytics                skip amplitude/firestore analytics calls\n' +
          '  --debug-hcaptcha              debug hCaptcha from capture files\n' +
          '  --capture-file <path>         capture log path (debug mode)\n' +
          '  --verbose|-v                  chatty per-step logging\n' +
          '  --help|-h                     show this help\n'
      );
      process.exit(0);
    }
  }
  return args;
}

function loadConfig(options = {}) {
  const { skipRequired = false, requirePhone = false } = options;
  // Captcha provider selection. Explicit CAPTCHA_PROVIDER env wins; otherwise
  // auto-pick the first configured key: nopecha > voidsolver > rezosolver > capless > onyx.
  const explicitProvider = (process.env.CAPTCHA_PROVIDER || '').trim().toLowerCase();
  const normalizedProvider = explicitProvider === 'rezo' ? 'rezosolver'
    : explicitProvider === 'void' ? 'voidsolver'
    : explicitProvider;
  const hasNopecha = !!(process.env.NOPECHA_API_KEY && !process.env.NOPECHA_API_KEY.startsWith('CHANGE_ME'));
  const hasVoid    = !!(process.env.VOIDSOLVER_API_KEY && !process.env.VOIDSOLVER_API_KEY.startsWith('CHANGE_ME'));
  const hasRezo    = !!(process.env.REZOSOLVER_API_KEY && !process.env.REZOSOLVER_API_KEY.startsWith('CHANGE_ME'));
  const hasCapless = !!(process.env.CAPLESS_API_KEY && !process.env.CAPLESS_API_KEY.startsWith('CHANGE_ME'));
  const hasOnyx    = !!(process.env.ONYX_API_KEY    && !process.env.ONYX_API_KEY.startsWith('CHANGE_ME') && process.env.ONYX_API_KEY !== 'onyx_replace_me');
  let captchaProvider;
  if (['nopecha', 'voidsolver', 'rezosolver', 'capless', 'onyx', 'manual'].includes(normalizedProvider)) {
    captchaProvider = normalizedProvider;
  } else if (hasNopecha) {
    captchaProvider = 'nopecha';
  } else if (hasVoid) {
    captchaProvider = 'voidsolver';
  } else if (hasRezo) {
    captchaProvider = 'rezosolver';
  } else if (hasCapless) {
    captchaProvider = 'capless';
  } else {
    captchaProvider = 'onyx';
  }
  const required = ['MEDAL_HCAPTCHA_SITEKEY', 'EMAIL_DOMAIN'];
  if (captchaProvider === 'manual') {
    // Manual mode: no API key. ManualSolver opens a visible Chromium window
    // rendering an hCaptcha widget for the sitekey, and the operator clicks
    // the checkbox / solves the puzzle by hand. The token is then captured
    // from the page and replayed into POST /api/users.
  } else if      (captchaProvider === 'nopecha')    required.push('NOPECHA_API_KEY');
  else if (captchaProvider === 'voidsolver') required.push('VOIDSOLVER_API_KEY');
  else if (captchaProvider === 'rezosolver') required.push('REZOSOLVER_API_KEY');
  else if (captchaProvider === 'capless')    required.push('CAPLESS_API_KEY');
  else                                       required.push('ONYX_API_KEY');
  if (requirePhone) required.push('FIVESIM_API_KEY');
  const missing = required.filter((k) => !process.env[k] ||
    process.env[k].startsWith('CHANGE_ME') ||
    process.env[k] === 'onyx_replace_me' ||
    process.env[k] === 'fivesim_replace_me');
  if (missing.length && !skipRequired) {
    console.error(
      `[config] Missing or placeholder values in .env: ${missing.join(', ')}`
    );
    console.error('         Copy .env.example to .env and fill them in.');
    process.exit(1);
  }
  return {
    onyxKey: process.env.ONYX_API_KEY,
    caplessKey: process.env.CAPLESS_API_KEY,
    nopechaKey: process.env.NOPECHA_API_KEY,
    voidKey: process.env.VOIDSOLVER_API_KEY,
    rezoKey: process.env.REZOSOLVER_API_KEY,
    captchaProvider,
    // Capless wants the BARE domain (e.g. "medal.tv") for its `site` field.
    // Strip any scheme/path the user might have set in MEDAL_CAPTCHA_PAGE.
    caplessSite: (process.env.CAPLESS_SITE || (process.env.MEDAL_CAPTCHA_PAGE || 'medal.tv').replace(/^https?:\/\//, '').replace(/\/.*$/, '')),
    // NopeCHA poll interval (ms). Their docs recommend ~500ms minimum between
    // 409-incomplete polls; faster than that risks rate-limit 429s.
    nopechaPollMs: parseInt(process.env.NOPECHA_POLL_MS || '750', 10),
    nopechaTimeoutMs: parseInt(process.env.NOPECHA_TIMEOUT_MS || '180000', 10),
    // Forward the rotating proxy into the NopeCHA job by default so the
    // solver's exit IP matches our subsequent /api/users POST. Setting
    // NOPECHA_USE_TASK_PROXY=0 omits the `proxy` field entirely — NopeCHA
    // will solve from their own pool, which is faster but may invalidate
    // the token if Medal's hCaptcha enforces strict IP matching.
    nopechaUseTaskProxy: (() => {
      const v = String(process.env.NOPECHA_USE_TASK_PROXY || '1').trim();
      return !(v === '0' || v.toLowerCase() === 'false' || v.toLowerCase() === 'no');
    })(),
    // RezoSolver (https://rezosolver.com/docs.html) — POST /createtask then
    // poll POST /gettaskresult every 1-2s. Rate limit: 15 req / 10s per IP.
    rezoPollMs: parseInt(process.env.REZOSOLVER_POLL_MS || '1500', 10),
    rezoTimeoutMs: parseInt(process.env.REZOSOLVER_TIMEOUT_MS || '180000', 10),
    rezoUseTaskProxy: (() => {
      const v = String(process.env.REZOSOLVER_USE_TASK_PROXY || '0').trim();
      return !(v === '0' || v.toLowerCase() === 'false' || v.toLowerCase() === 'no');
    })(),
    // RezoSolver rate-limits by the IP that hits /createtask and /gettaskresult
    // (15 req / 10s per IP). With many workers on one VPS they all share the
    // server egress IP unless we proxy those API calls too. Default ON: route
    // RezoSolver HTTP through the same worker proxy (different ssid = different
    // exit IP per worker). Set REZOSOLVER_USE_API_PROXY=0 to hit Rezo direct.
    rezoUseApiProxy: (() => {
      const v = String(process.env.REZOSOLVER_USE_API_PROXY || '1').trim();
      return !(v === '0' || v.toLowerCase() === 'false' || v.toLowerCase() === 'no');
    })(),
    // VoidSolver (https://voidsolver.tech/docs) — Bearer auth, POST /createtask
    // then GET /gettaskresult?taskid= (poll >=2s). Generic hCaptcha API: accepts
    // any site_url + site_key (no per-site whitelist like RezoSolver).
    voidPollMs: parseInt(process.env.VOIDSOLVER_POLL_MS || '2000', 10),
    voidTimeoutMs: parseInt(process.env.VOIDSOLVER_TIMEOUT_MS || '180000', 10),
    voidUseTaskProxy: (() => {
      const v = String(process.env.VOIDSOLVER_USE_TASK_PROXY || '0').trim();
      return !(v === '0' || v.toLowerCase() === 'false' || v.toLowerCase() === 'no');
    })(),
    // Advanced solver (POST /solve-advance) sends user_agent; use if standard fails.
    voidUseAdvanced: (() => {
      const v = String(process.env.VOIDSOLVER_USE_ADVANCED || '0').trim();
      return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes';
    })(),
    sitekey: process.env.MEDAL_HCAPTCHA_SITEKEY,
    captchaPage: process.env.MEDAL_CAPTCHA_PAGE || 'https://medal.tv/',
    emailDomain: process.env.EMAIL_DOMAIN,
    accountsFile: path.resolve(
      __dirname,
      process.env.ACCOUNTS_FILE || 'accounts.jsonl'
    ),
    failedAccountsFile: path.resolve(
      __dirname,
      process.env.FAILED_ACCOUNTS_FILE || 'failed-accounts.jsonl'
    ),
    // Java-cookie flow: the Microsoft/Minecraft identities the operator wants
    // to put on DonutSMP are exported as Netscape cookie .txt files into
    // JAVA_COOKIE_DIR (or passed directly via --java-cookie <file-or-dir>).
    // For each new Medal account the bot: signup -> 5sim phone verify -> try
    // the remaining cookies until one links this account -> enroll the DonutSMP
    // quest -> upload/post the clip. The reward is redeemed in-game as the
    // linked Java account on DonutSMP, never claimed by the bot.
    javaCookieDir: path.resolve(
      __dirname,
      process.env.JAVA_COOKIE_DIR || 'java_cookies'
    ),
    // Delay between accounts when processing a whole cookie directory (ms).
    javaCookieDelayMs: parseInt(
      process.env.JAVA_COOKIE_DELAY_MS || '3000',
      10
    ),
    // Cookie files that FAILED the Microsoft link (session rejected, identity
    // already bound to another Medal account, …) are MOVED here so re-runs
    // skip them instead of burning a fresh 5sim number on the same dead cookie.
    badJavaCookiesDir: path.resolve(
      __dirname,
      process.env.JAVA_BAD_COOKIES_DIR || 'bad_java_cookies'
    ),
    // Cookies that successfully redeemed /medal are moved here.
    redeemedJavaCookiesDir: path.resolve(
      __dirname,
      process.env.JAVA_REDEEMED_COOKIES_DIR || 'redeemed_java_cookies'
    ),
    // Optional cap on how many fresh Medal accounts one java run may create.
    // When unset/0 the run keeps going until the cookie pool is exhausted.
    javaMaxAccounts: parseInt(process.env.JAVA_MAX_ACCOUNTS || '0', 10) || 0,
    // How long a single Microsoft-link attempt may take (consent page + OAuth
    // round-trip) before the cookie is treated as dead.
    javaLinkTimeoutMs: parseInt(
      process.env.JAVA_LINK_TIMEOUT_MS || '240000',
      10
    ),
    // Which egress the Microsoft-link Chromium window uses. The exported MSA
    // cookies were minted on the operator's own IP, so 'direct' (default) is
    // what Microsoft will accept most readily; 'proxy' forces the account proxy.
    javaLinkProxyMode: String(process.env.JAVA_LINK_PROXY || 'direct')
      .trim()
      .toLowerCase(),
    proxiesFile: path.resolve(
      __dirname,
      process.env.PROXIES_FILE || 'proxies.txt'
    ),
    // File that records which proxies have already been assigned to an account,
    // so no two accounts ever share an upstream egress IP. PROXY_RESET=1 clears
    // the file (allows the pool to be re-used) when it is exhausted.
    proxyUsedFile: path.resolve(
      __dirname,
      process.env.PROXY_USED_FILE || 'used_proxies.json'
    ),
    proxyReset: (() => {
      const v = String(process.env.PROXY_RESET || '0').trim();
      return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes';
    })(),
    timezone: process.env.MEDAL_TIMEZONE || 'Asia/Jakarta',
    discordWebhookUrl: String(process.env.DISCORD_WEBHOOK_URL || '').trim() || null,

    fivesim: (() => {
      // ---- Geo preset ----
      // FIVESIM_USE_NETHERLANDS=1 swaps the country + operator defaults to
      // a Netherlands preset in one go (no need to also flip
      // FIVESIM_COUNTRY / FIVESIM_OPERATOR / FIVESIM_OPERATOR_FALLBACKS by
      // hand). Explicit per-field env overrides still win — the toggle
      // only changes the *defaults* when the corresponding env var is
      // unset, so power users can mix & match (e.g. NL country with a
      // hand-picked operator list).
      //
      // As of last manual check on 5sim's UI for product=medal:
      //   england:     virtual59 4.55% (BEST), virtual60 3.29%,
      //                virtual58 1.55%, virtual51 0.92%.
      //   netherlands: virtual51 100% (BEST),  virtual53 88.46%,
      //                virtual58 54.43%, virtual59 / virtual60 n/a yet.
      //
      // Netherlands is currently a *much* better source for medal/* —
      // success rates an order of magnitude higher than UK. England is
      // kept as the default for backwards compat with the existing
      // .env / accounts.jsonl layout.
      const useNL = /^(1|true|yes)$/i.test(
        String(process.env.FIVESIM_USE_NETHERLANDS || '').trim()
      );
      const geoDefaults = useNL
        ? {
            country: 'netherlands',
            operator: 'virtual51',
            // n/a-rate operators (virtual59/60) go LAST — we have no
            // delivery-rate data on them yet, so don't trust them above
            // the 88% / 54% known-good ones.
            operatorFallbacks: 'virtual53,virtual58,virtual59,virtual60',
          }
        : {
            country: 'england',
            operator: 'virtual59',
            operatorFallbacks: 'virtual60,virtual58,virtual51',
          };

      return {
      apiKey: process.env.FIVESIM_API_KEY || null,
      country: process.env.FIVESIM_COUNTRY || geoDefaults.country,
      // Primary operator preference; comma-separated fallbacks are honoured in order.
      // If the primary runs out of stock (5sim returns "no free phones"), the bot
      // automatically tries the next operator in FIVESIM_OPERATOR_FALLBACKS.
      // Defaults are picked from the geo preset above (England by default,
      // Netherlands when FIVESIM_USE_NETHERLANDS=1). 5sim periodically
      // adds/removes operators per country/product, so revisit these if
      // success rate craters.
      operator: process.env.FIVESIM_OPERATOR || geoDefaults.operator,
      operatorFallbacks: (
        process.env.FIVESIM_OPERATOR_FALLBACKS || geoDefaults.operatorFallbacks
      )
        .split(',')
        .map((s) => s.trim())
        // The 'any' wildcard routes orders to whichever operator has the
        // most stock — which in practice is the lowest-success-rate one
        // (virtual51 sits at ~2% rate with 60k+ stock on UK). Strip it
        // unconditionally; users that want broad coverage should list
        // specific operators in FIVESIM_OPERATOR_FALLBACKS instead.
        .filter((s) => s && s.toLowerCase() !== 'any'),
      product: process.env.FIVESIM_PRODUCT || 'medal',
      // Per-attempt wait (lowered from 5min so burned numbers get recycled fast)
      waitMs: parseInt(process.env.FIVESIM_WAIT_MS || '90000', 10),
      pollMs: parseInt(process.env.FIVESIM_POLL_MS || '5000', 10),
      // How many phone numbers to try before giving up (each costs ~$0.08).
      // Acts as a hard ceiling across all operators. Default 12 = 4 ops * 3.
      phoneRetries: parseInt(process.env.FIVESIM_PHONE_RETRIES || '12', 10),
      // After this many consecutive failures on a single operator (e.g. dead
      // virtual58 numbers that never deliver SMS), rotate to the next operator
      // instead of burning the rest of the retry budget on the same dud pool.
      maxAttemptsPerOperator: parseInt(
        process.env.FIVESIM_MAX_ATTEMPTS_PER_OPERATOR || '3',
        10
      ),
      // ---- Dynamic operator ranking (5sim guest /prices API) ----
      // When enabled (default), every verifyPhone() call queries 5sim's
      // public price/stock/success-rate feed and orders operators by
      // success rate desc, cost asc — instead of trusting the static
      // FIVESIM_OPERATOR / FIVESIM_OPERATOR_FALLBACKS list. The static
      // list is still used as a fallback if the API is unreachable.
      // The 'any' wildcard is ALWAYS filtered out — it routes orders to
      // whichever operator has stock (often the cheapest = lowest success
      // rate one) which defeats the purpose of ranking.
      useDynamicRanking: (() => {
        const v = String(process.env.FIVESIM_DYNAMIC_RANKING || '1').trim();
        return v !== '0' && v !== 'false' && v !== 'no';
      })(),
      // Reject operators with success rate below this %. Filters trash like
      // virtual51 (2.2%) and virtual59 (3.2%) that are stocked but useless.
      // 0 = no filter.
      minRate: parseFloat(process.env.FIVESIM_MIN_RATE || '10'),
      // Reject operators whose cost exceeds this (in 5sim account currency,
      // e.g. USD). 0 = no ceiling. Useful if pricier operators are present
      // and you want to hard-cap per-number spend.
      maxCost: parseFloat(process.env.FIVESIM_MAX_COST || '0'),
      // How long to cache the /prices response per process. Stock changes
      // fast; rates change slowly. 3 min is a good compromise.
      pricesCacheTtlMs: parseInt(
        process.env.FIVESIM_PRICES_CACHE_TTL_MS || '180000',
        10
      ),
      // Hard ceiling on dynamically-ranked operators we'll actually use.
      // The rest of the list serves as fallback only if the top picks
      // surprise us with no-stock at buy time.
      maxOperators: parseInt(process.env.FIVESIM_MAX_OPERATORS || '6', 10),
      // Floor for the EXPANDED-POOL fallback (engaged only after the
      // standard top-N is fully number-blocked by Medal). Operators below
      // this rate will accept phones at Medal but virtually never deliver
      // an SMS, burning 90s/attempt of poll time for nothing — so we skip
      // them entirely. Default 1%: keeps virtual59 (3.2%) reachable while
      // excluding virtual51 (0.9%) / virtual60 (0.3%).
      expandedMinRate: parseFloat(process.env.FIVESIM_EXPANDED_MIN_RATE || '1'),
      // After every named operator is exhausted (out of stock at buy time
      // OR fully number-blocked OR hit per-op fail cap), try the special
      // 'any' operator as a final last-resort. 5sim routes 'any' orders
      // to whichever operator has stock backend-side, including ranges
      // /guest/prices may not list (newly-onboarded ops, partner pools,
      // hidden inventory). This is normally avoided because 'any' tends
      // to land on the lowest-success-rate range — but at this point a
      // 1% chance beats giving up. Default ON; set FIVESIM_USE_ANY_LAST
      // RESORT=0 to disable.
      useAnyAsLastResort: (() => {
        const v = String(process.env.FIVESIM_USE_ANY_LAST_RESORT ?? '1').trim();
        return v !== '0' && v !== 'false' && v !== 'no';
      })(),
      // After this many CONSECUTIVE Medal-side rejections (4xx on the
      // settings POST OR silent unverifiedPhone-mismatch), conclude that
      // the Medal account itself is throttled/banned at the user level
      // and bail out with failReason='medal_account_throttled' instead
      // of grinding through more 5sim numbers. The worker loop catches
      // this signal and (a) treats the account as unusable and
      // (b) retries the same Java account (Microsoft cookie) with a fresh Medal account.
      medalRejectThreshold: parseInt(
        process.env.MEDAL_REJECT_THRESHOLD || '3',
        10
      ),
      // How many CONSECUTIVE errorId:37 ("Number blocked for SMS") rejections
      // we tolerate on a single operator before giving up on it and rotating.
      // This is INTENTIONALLY higher than the per-op cap for SMS-timeouts
      // (FIVESIM_MAX_ATTEMPTS_PER_OPERATOR) because errorId:37 is per-NUMBER
      // not per-OPERATOR — many fresh numbers from the same op are still
      // unblocked at Medal even when others are flagged. Default 6 means
      // we'll burn up to 6 numbers from the same op before declaring its
      // whole range Medal-blocked.
      numberBlockRetries: parseInt(
        process.env.MEDAL_NUMBER_BLOCK_RETRIES || '6',
        10
      ),
      };
    })(),
    captchaRetries: parseInt(process.env.ONYX_CAPTCHA_RETRIES || '7', 10),
    // When true, passes your rotating proxy to OnyxSolver so the captcha is
    // solved from the same IP as the Medal signup (better success rate but
    // burns residential GB for captcha challenge assets). When false, Onyx
    // solves from its own infrastructure (proxyless — saves GB, may lower
    // success rate if Medal validates solve-IP vs signup-IP).
    onyxUseTaskProxy: (() => {
      const v = String(process.env.ONYX_USE_TASK_PROXY || '1').trim();
      return v !== '0' && v !== 'false' && v !== 'no';
    })(),
    questId: process.env.MEDAL_QUEST_ID || '2pQLGqBjtd',
    phoneVerifyEndpoint:
      process.env.MEDAL_PHONE_VERIFY_ENDPOINT || '/api/users/{userId}/settings',
    phoneVerifyBodyField:
      process.env.MEDAL_PHONE_VERIFY_FIELD || 'phoneVerificationCode',

    clip: {
      path: process.env.MEDAL_CLIP_PATH || null,
      title: process.env.MEDAL_CLIP_TITLE || 'DonutSMP Minecraft Gameplay',
      description: process.env.MEDAL_CLIP_DESCRIPTION || '#donutsmp',
      tags: (process.env.MEDAL_CLIP_TAGS || 'donutsmp,minecraft')
        .split(',').map((t) => t.trim()).filter(Boolean),
      categoryId: process.env.MEDAL_CLIP_CATEGORY_ID || MINECRAFT_CATEGORY_ID,
      duration: parseFloat(process.env.MEDAL_CLIP_DURATION || '0') || 30,
      // privacy: 0=PUBLIC (posts to profile - required for the DonutSMP quest),
      //         1=UNLISTED, 2=PRIVATE, 3=SAVED_TO_LIBRARY
      privacy: parseInt(process.env.MEDAL_CLIP_PRIVACY || '0', 10),
      // How long to wait for transcoding to finish before finalizing the post
      timeoutMs: parseInt(process.env.MEDAL_CLIP_TIMEOUT_MS || '120000', 10),
      pollMs: parseInt(process.env.MEDAL_CLIP_POLL_MS || '3000', 10),
    },
  };
}

// --------------------------------------------------------------------------
// Random data helpers
// --------------------------------------------------------------------------
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';
const ALPHA = LOWER + LOWER.toUpperCase();
const ALNUM = ALPHA + DIGITS;

function randChoice(s) {
  return s[crypto.randomInt(s.length)];
}

function randString(n, alphabet = LOWER + DIGITS) {
  let out = '';
  for (let i = 0; i < n; i++) out += randChoice(alphabet);
  return out;
}

function randInt(lo, hi) {
  return crypto.randomInt(lo, hi + 1);
}

function newIdentity(emailDomain) {
  const ulen = randInt(6, 10);
  const body = randString(ulen, LOWER + DIGITS);
  const username = body + (Math.random() < 0.5 ? '_' : '');

  const local = randString(randInt(6, 12));
  const email = `${local}@${emailDomain}`;

  // password: matches the captured "-0-123490fdns" shape so relatedWords
  // entropy check stays well above threshold
  const pwAlpha = ALNUM + '-_';
  const password = '-' + randString(randInt(10, 14), pwAlpha);

  const birthYear = randInt(1970, 2006);
  const birthMonth = randInt(1, 12);
  const birthDay = randInt(1, 28);

  return { email, username, password, birthYear, birthMonth, birthDay };
}

function newDeviceFingerprint() {
  const nowMs = Date.now();
  return {
    deviceId: String(randInt(10 ** 8, 10 ** 9 - 1)),
    sessionId: nowMs - randInt(5 * 60_000, 30 * 60_000),
    sessionIdSecondary: nowMs - randInt(2 * 60_000, 10 * 60_000),
    eventId: randInt(15000, 25000),
  };
}

function nextEventId(fp) {
  fp.eventId += 1;
  return fp.eventId;
}

function isoUtcNowMs() {
  // Amplitude wants ms precision and trailing Z
  return new Date().toISOString().replace(/Z$/, 'Z');
}

function extractSitekeysFromText(text) {
  const candidates = new Set();
  const weakCandidates = new Set();
  const uuidPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
  const sitekeyQueryPattern = /[?&]sitekey=([0-9a-z-]+)/gi;
  const hcaptchaHostPattern =
    /https?:\/\/(?:[\w-]+\.)?(?:hcaptcha\.com|newassets\.hcaptcha\.com|[\w-]+\.w\.hcaptcha\.com)[^\s"']*/gi;
  const rqdataPattern = /\brqdata\b/gi;
  const keyWordsPattern = /\b(checksiteconfig|getcaptcha|hcaptcha)\b/gi;

  let m;
  while ((m = sitekeyQueryPattern.exec(text)) !== null) {
    if (m[1]) candidates.add(m[1]);
  }
  // Only treat UUIDs as weak candidates when they appear on lines that already
  // mention hcaptcha or sitekey. This avoids idempotency-key false positives.
  const lines = text.split('\n');
  for (const line of lines) {
    if (!/hcaptcha|sitekey|checksiteconfig|getcaptcha/i.test(line)) continue;
    while ((m = uuidPattern.exec(line)) !== null) {
      weakCandidates.add(m[0]);
    }
    uuidPattern.lastIndex = 0;
  }

  const hcaptchaUrls = [];
  while ((m = hcaptchaHostPattern.exec(text)) !== null) {
    hcaptchaUrls.push(m[0]);
  }
  const keywordHits = text.match(keyWordsPattern) || [];
  const rqdataHits = text.match(rqdataPattern) || [];

  return {
    candidates: Array.from(candidates),
    weakCandidates: Array.from(weakCandidates),
    hcaptchaUrls,
    keywordHits: keywordHits.length,
    rqdataHits: rqdataHits.length,
  };
}

function debugHcaptchaFromFiles(filePaths) {
  const existing = filePaths.filter((p) => p && fs.existsSync(p));
  if (existing.length === 0) {
    console.error('[debug-hcaptcha] no capture file found.');
    console.error('[debug-hcaptcha] use --capture-file /path/to/httprequest.txt');
    return false;
  }

  let foundAny = false;
  for (const filePath of existing) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const result = extractSitekeysFromText(raw);
    console.log(`\n[debug-hcaptcha] scanning: ${filePath}`);
    console.log(`[debug-hcaptcha] hcaptcha-like URLs found: ${result.hcaptchaUrls.length}`);
    console.log(`[debug-hcaptcha] keyword hits (hcaptcha/checksiteconfig/getcaptcha): ${result.keywordHits}`);
    console.log(`[debug-hcaptcha] rqdata hits: ${result.rqdataHits}`);
    if (result.candidates.length > 0) {
      foundAny = true;
      console.log('[debug-hcaptcha] strong sitekey candidates (from sitekey= query):');
      for (const c of result.candidates) {
        console.log(`  - ${c}`);
      }
    } else if (result.weakCandidates.length > 0) {
      console.log('[debug-hcaptcha] weak UUID candidates near hcaptcha/sitekey lines:');
      for (const c of result.weakCandidates) {
        console.log(`  - ${c}`);
      }
      console.log('[debug-hcaptcha] these may still be unrelated; prefer a URL that explicitly has sitekey=');
    } else {
      console.log('[debug-hcaptcha] no sitekey candidate found in this file.');
    }

    const interestingLines = raw
      .split('\n')
      .filter((line) => /hcaptcha|sitekey|checksiteconfig|getcaptcha|rqdata/i.test(line))
      .slice(0, 30);
    if (interestingLines.length > 0) {
      console.log('[debug-hcaptcha] first matching lines (up to 30):');
      for (const line of interestingLines) console.log(`  ${line}`);
    }
  }

  if (!foundAny) {
    console.log('\n[debug-hcaptcha] no sitekey was extracted.');
    console.log('[debug-hcaptcha] capture one full signup attempt again in HTTP Toolkit and filter by:');
    console.log('  hcaptcha.com');
    console.log('[debug-hcaptcha] then inspect requests to:');
    console.log('  - /checksiteconfig');
    console.log('  - /getcaptcha');
    console.log('  - newassets.hcaptcha.com/captcha/v1/... (query can include sitekey=...)');
  }
  return foundAny;
}

// --------------------------------------------------------------------------
// Proxy handling
// --------------------------------------------------------------------------
function normalizeProxy(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s || s.startsWith('#')) return null;

  // already has a scheme
  if (/^[a-z0-9]+:\/\//i.test(s)) return s;

  const parts = s.split(':');

  // host:port:user:pass  (4 parts)
  if (parts.length === 4) {
    const [host, port, user, pass] = parts;
    return `http://${user}:${pass}@${host}:${port}`;
  }

  // user:pass@host:port  (no scheme, but has @)
  if (s.includes('@')) return `http://${s}`;

  // host:port  (2 parts)
  return `http://${s}`;
}

function loadProxiesFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs
      .readFileSync(filePath, 'utf8')
      .split('\n')
      .map((l) => normalizeProxy(l))
      .filter(Boolean);
  } catch (e) {
    return [];
  }
}

// --------------------------------------------------------------------------
// One-proxy-per-account tracking.
//
// Every account is pinned to a single upstream IP (sticky residential session
// when the proxy URL carries an ssid-XXXX token). To make sure no TWO accounts
// ever share the same egress, we record each proxy in a JSON file the moment we
// hand it to an account and refuse to hand it out again. PROXY_RESET=1 clears
// the file once the pool is exhausted so a run can recycle the proxies.
// --------------------------------------------------------------------------

function loadUsedProxies(filePath) {
  try {
    if (!fs.existsSync(filePath)) return new Set();
    const arr = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.map((p) => String(p)));
  } catch (_) {
    // Corrupt / half-written file — treat as empty rather than aborting.
    return new Set();
  }
}

function saveUsedProxies(filePath, used) {
  try {
    fs.writeFileSync(filePath, JSON.stringify([...used], null, 2) + '\n');
  } catch (_) {
    /* best-effort persistence; a missing used-list only risks an IP re-use */
  }
}

function markProxyUsed(filePath, proxyUrl) {
  if (!proxyUrl || !filePath) return;
  const used = loadUsedProxies(filePath);
  used.add(proxyUrl);
  saveUsedProxies(filePath, used);
}

/**
 * Pick a proxy for the next account that has NOT already been assigned.
 * Guarantees one upstream IP per account across the whole run.
 *
 * Returns { proxy, exhausted }:
 *   - proxy:     a normalized proxy URL, or null when none is free.
 *   - exhausted: true when the pool ran dry AND PROXY_RESET is off (caller
 *                should stop); when PROXY_RESET is on the used-list is cleared
 *                and a proxy from the full pool is returned instead.
 *
 * When `proxies` is empty (no proxy file → direct connection) this returns
 * { proxy: null, exhausted: false } so existing behaviour is untouched.
 */
function acquireProxy(proxies, usedFile, reset) {
  if (!proxies || proxies.length === 0) return { proxy: null, exhausted: false };
  const used = loadUsedProxies(usedFile);
  let free = proxies.filter((p) => !used.has(p));
  if (free.length === 0) {
    if (!reset) {
      return { proxy: null, exhausted: true };
    }
    saveUsedProxies(usedFile, new Set());
    free = proxies.slice();
  }
  // Random pick among the free pool (spreads concurrent-ish use of a file).
  const proxy = free[Math.floor(Math.random() * free.length)];
  return { proxy, exhausted: false };
}

function proxyAgent(proxyUrl) {
  if (!proxyUrl) return null;
  if (proxyUrl.startsWith('socks')) return new SocksProxyAgent(proxyUrl);
  return new HttpsProxyAgent(proxyUrl);
}

/**
 * If `proxyUrl` contains a residential-proxy session-id token (`ssid-XXXX`,
 * `sessid-XXXX`, `session-XXXX`, or `sessionid-XXXX` — niceproxy, 9proxy,
 * beeproxy, GoProxies, Novada, etc. all use this convention), replace the
 * id with a freshly random one. Returns the same URL otherwise.
 *
 * WHY: with concurrent workers we want a DIFFERENT upstream IP per account,
 * but the SAME IP across all the API calls of one account (fraud systems
 * expect a coherent IP per session, not 8 different IPs in 30s). By rotating
 * the ssid once per createAccount call we get exactly that — every signup
 * pins its own sticky session, and 100 workers = 100 different upstream IPs.
 *
 * If the proxy has no session token at all (i.e. true rotating mode where
 * every TCP CONNECT picks a fresh IP), the URL is returned untouched.
 */
function rotateProxySessionId(proxyUrl) {
  if (!proxyUrl) return proxyUrl;
  const tokenRe = /(?<=[-_])(ssid|sessid|session|sessionid)-([A-Za-z0-9]+)/i;
  const m = proxyUrl.match(tokenRe);
  if (!m) return proxyUrl; // already pure-rotating (no session pin)
  // IMPORTANT: only alphanumeric. Residential-proxy backends (niceproxy,
  // 9proxy, beeproxy, etc.) split the username on `-` to read parameters
  // like `country-US`, `ssid-XXX`. If the random id contains `-` or `_`
  // (which base64url does!), the parser sees `ssid-Wge` followed by an
  // unknown `P` parameter and returns 407 "Unauthorized Username invalid".
  // Hex is safe because it's strictly [0-9a-f]. 12 chars = 48 bits of
  // entropy which is way more than enough for ~10 min sticky sessions.
  const fresh = crypto.randomBytes(6).toString('hex');
  return proxyUrl.replace(tokenRe, `${m[1]}-${fresh}`);
}

/**
 * Heuristic: is `err` a transient proxy / network failure that's worth
 * retrying with a fresh upstream IP? Returns true for:
 *   - HTTP 407 Proxy Authentication Required (most common: malformed ssid,
 *     burned proxy session, provider rate-limiting an IP)
 *   - Node net errors: ECONNRESET, ECONNREFUSED, ETIMEDOUT, ENOTFOUND, …
 *   - https-proxy-agent's "tunneling socket could not be established"
 *   - Upstream 5xx (Medal, GCS, etc. occasionally emit 502/503/504 when
 *     a residential IP is rate-limited at the edge — also worth retrying
 *     with a fresh IP)
 *
 * False on application errors like "captcha invalid", "username taken",
 * "phone code wrong" — those are not proxy-fixable.
 */
function isProxyError(err) {
  if (!err) return false;
  const msg = String(err.message || err);
  // OnyxSolver exhausting all internal retries is treated as a proxy issue
  // because all of its "Captcha failed to load" / "network_error" /
  // "net_timeout" failures mean the residential IP we passed in `taskProxy`
  // can't reach hCaptcha. Rotating to a fresh upstream IP almost always fixes it.
  if (err.failReason === 'captcha_exhausted') return true;
  if (/\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE|ERR_BAD_RESPONSE|ERR_NETWORK)\b/.test(msg)) return true;
  if (/->\s*407\b/.test(msg) || /\bProxy Authentication\b/i.test(msg)) return true;
  if (/Unauthorized\s+Username\s+invalid/i.test(msg)) return true; // niceproxy 407 body
  if (/tunneling socket could not be established/i.test(msg)) return true;
  if (/socket hang up/i.test(msg)) return true;
  if (/->\s*(502|503|504)\b/.test(msg)) return true;
  // OnyxSolver network-failure surface (proxy IP can't reach hCaptcha properly)
  if (/Captcha failed:\s*net:\s*net_timeout/i.test(msg)) return true;
  if (/Captcha failed:\s*network_error/i.test(msg)) return true;
  if (/Captcha failed to load/i.test(msg)) return true;
  if (/OnyxSolver timed out waiting for solution/i.test(msg)) return true;
  return false;
}

/**
 * One-shot diagnostic at boot describing the proxy mode so the operator
 * isn't surprised when 100 workers all share an IP (or alternately, all
 * get different ones). Call once after the proxy list is loaded.
 */
function describeProxyMode(proxies, log) {
  if (proxies.length === 0) return;
  const sample = proxies[0];
  const tokenRe = /[-_](ssid|sessid|session|sessionid)-([A-Za-z0-9]+)/i;
  const m = sample.match(tokenRe);
  if (m) {
    log(
      `proxy mode: STICKY-SESSION detected (${m[1]}-${m[2].slice(0, 4)}…). ` +
        `Auto-rotating session id per account so each signup gets its own upstream IP.`
    );
  } else {
    log(
      'proxy mode: PURE-ROTATING assumed (no ssid/session token in URL). ' +
        'Every TCP CONNECT will pick a fresh IP from the upstream pool.'
    );
  }
}

// --------------------------------------------------------------------------
// HTTP session wrapper
// --------------------------------------------------------------------------
class MedalClient {
  constructor({ proxy, timezone }) {
    this.proxy = proxy || null;
    this.timezone = timezone;
    const agent = proxyAgent(this.proxy);
    this.http = axios.create({
      timeout: 30_000,
      httpAgent: agent,
      httpsAgent: agent,
      // we handle non-2xx manually so we can inspect the body
      validateStatus: () => true,
      // don't auto-escape bodies
      transitional: { clarifyTimeoutError: true },
    });
  }

  medalHeaders(extra = {}) {
    return {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      'Accept-Language': 'en-US',
      'Circuit-Breaker-Status': 'closed,11,0',
      Connection: 'keep-alive',
      'Content-Type': 'application/json',
      Host: 'medal.tv',
      'idempotency-key': `"${uuidv4()}"`,
      'Medal-User-Agent': MEDAL_UA,
      'sec-ch-ua': '"Not(A:Brand";v="8", "Chromium";v="144"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'cross-site',
      'User-Agent': MEDAL_UA,
      'X-Timezone': this.timezone,
      ...extra,
    };
  }

  amplitudeHeaders() {
    return {
      Accept: '*/*',
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      'Accept-Language': 'en-US',
      Connection: 'keep-alive',
      'Content-Type': 'application/json',
      Host: 'ampltd2.medal.tv',
      'sec-ch-ua': '"Not(A:Brand";v="8", "Chromium";v="144"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'cross-site',
      'User-Agent': MEDAL_UA,
    };
  }

  async postJson(url, body, headers) {
    const r = await this.http.post(url, body, { headers });
    if (r.status >= 400) {
      const preview =
        typeof r.data === 'string' ? r.data.slice(0, 400) : JSON.stringify(r.data).slice(0, 400);
      throw new Error(`POST ${url} -> ${r.status}: ${preview}`);
    }
    return r.data;
  }

  async getJson(url, headers) {
    const r = await this.http.get(url, { headers });
    return { status: r.status, data: r.data };
  }
}

// --------------------------------------------------------------------------
// OnyxSolver client
// --------------------------------------------------------------------------
class OnyxSolver {
  constructor({ apiKey, taskProxy = null }) {
    this.apiKey = apiKey;
    this.taskProxy = taskProxy; // proxy to pass INTO the task (not to reach onyx)
    this.http = axios.create({ timeout: 60_000, validateStatus: () => true });
  }

  async createTask({ websiteUrl, siteKey }) {
    const task = {
      type: 'PopularCaptchaTaskProxyless',
      websiteURL: websiteUrl,
      websiteKey: siteKey,
      isInvisible: true,  // Medal uses size:"invisible" hCaptcha
    };
    if (this.taskProxy) {
      task.type = 'PopularCaptchaTask';
      task.proxy = this.taskProxy.replace(/^[a-z0-9]+:\/\//i, ''); // strip scheme
    }

    const r = await this.http.post(`${ONYX_BASE}/api/createTask`, {
      clientKey: this.apiKey,
      task,
    });
    const data = r.data || {};
    if (data.errorId !== 0 || !data.taskId) {
      throw new Error(
        `OnyxSolver createTask failed: ${JSON.stringify(data).slice(0, 400)}`
      );
    }
    return data.taskId;
  }

  async waitForSolution(taskId, timeoutMs = 180_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const r = await this.http.post(`${ONYX_BASE}/api/getTaskResult`, {
        clientKey: this.apiKey,
        taskId,
      });
      const data = r.data || {};
      if (data.errorId !== 0) {
        throw new Error(
          `OnyxSolver error: ${data.errorDescription || JSON.stringify(data)}`
        );
      }
      if (data.status === 'ready') return data.solution;
      await new Promise((res) => setTimeout(res, 3000));
    }
    throw new Error('OnyxSolver timed out waiting for solution');
  }

  async report(taskId, result) {
    try {
      await this.http.post(`${ONYX_BASE}/api/reportTaskResult`, {
        clientKey: this.apiKey,
        taskId,
        result,
      });
    } catch (_) {
      /* swallow */
    }
  }
}

// --------------------------------------------------------------------------
// Manual solver (you solve the captcha yourself).
//
// Exposes the same {createTask, waitForSolution, report} surface as the API
// solvers so the retry loop in createAccount() stays provider-blind, but
// instead of calling a solving service it opens a HEADFUL Chromium window
// (through the same proxy the signup HTTP traffic will egress from) rendering
// an hCaptcha widget for the target sitekey. The operator clicks the checkbox
// / solves any puzzle by hand; the widget's response token is polled out of
// the page and returned as the gRecaptchaResponse that gets posted to
// POST /api/users.
//
// IMPORTANT (IP binding): the token is minted by hCaptcha against the IP the
// browser egresses from. For Medal to accept it, that must be the SAME IP the
// account's HTTP replay uses. When a worker proxy is configured we route the
// browser through it too; with no proxy (e.g. an own-IP test) both the browser
// and the axios client use your machine's real IP, which is consistent.
//
// DOMAIN note: hCaptcha sitekeys are normally registered to a domain. If the
// sitekey Medal uses is domain-locked, the widget inside this local harness
// will show an "invalid domain" error and no checkbox will render — in that
// case the widget must be driven from a real medal.tv page instead (see the
// error forwarded from the harness console). Most third-party solver APIs get
// away with rendering off-site, so many sitekeys are not strictly locked.
// --------------------------------------------------------------------------
class ManualSolver {
  constructor({ taskProxy = null } = {}) {
    this.taskProxy = taskProxy; // http:// or socks5:// url (same as the HTTP client)
    this._browser = null;
    this._server = null;
    this._token = null;
  }

  // Convert the bot's proxy URL into playwright's {server, username, password}
  // shape, or undefined when no proxy (browser uses the machine's real IP).
  _playwrightProxy() {
    if (!this.taskProxy) return undefined;
    let s = String(this.taskProxy).trim();
    let scheme = 'http';
    const sc = s.match(/^([a-z0-9]+):\/\//i);
    if (sc) {
      scheme = sc[1];
      s = s.slice(sc[0].length);
    }
    const at = s.lastIndexOf('@');
    let hostport = s;
    const cfg = {};
    if (at !== -1) {
      const creds = s.slice(0, at).split(':');
      cfg.username = decodeURIComponent(creds[0]);
      cfg.password = decodeURIComponent(creds.slice(1).join(':'));
      hostport = s.slice(at + 1);
    }
    cfg.server = `${scheme}://${hostport}`;
    return cfg;
  }

  // Tiny throwaway server that serves the widget harness page. Keeping it on
  // 127.0.0.1 avoids file:// / data: origin restrictions on hCaptcha's api.js.
  async _serveHarness(siteKey) {
    const http = require('http');
    const html = `<!doctype html><html><head><meta charset="utf-8">
<title>Manual hCaptcha — solve in this window</title>
<style>
  body{font-family:system-ui,Segoe UI,Roboto,sans-serif;background:#101216;color:#eee;
       display:flex;flex-direction:column;align-items:center;padding:32px;gap:14px;}
  .box{background:#1b1f27;border:1px solid #333;border-radius:12px;padding:22px;max-width:420px;text-align:center;}
  h2{margin:0 0 6px;font-size:17px;} p{margin:6px 0;font-size:13px;color:#bbb;line-height:1.5;}
  #cap{min-height:80px;display:flex;justify-content:center;margin-top:10px;}
  #status{font-size:12px;color:#7fb069;}
</style></head><body>
<div class="box">
  <h2>Solve the captcha</h2>
  <p>Click the checkbox below. If an image puzzle pops up, complete it.
     This window closes itself automatically once the token is captured.</p>
  <div id="cap"></div>
  <div id="status">waiting…</div>
</div>
<script src="https://hcaptcha.com/1/api.js?onload=_hcapOnload&render=explicit" async defer></script>
<script>
var SITEKEY = ${JSON.stringify(String(siteKey))};
window.__manualToken = null;
function _hcapOnload(){
  try {
    window.hcaptcha.render('cap', { sitekey: SITEKEY, size: 'normal', theme: 'dark' });
    window.__hcapReady = true;
    document.getElementById('status').textContent = 'widget loaded — click the checkbox';
  } catch (e) {
    document.getElementById('status').textContent = 'widget error: ' + e.message;
    document.getElementById('status').style.color = '#e06666';
  }
}
setInterval(function(){
  try {
    var r = window.hcaptcha && window.hcaptcha.getResponse && window.hcaptcha.getResponse();
    if (r && !window.__manualToken) {
      window.__manualToken = r;
      document.getElementById('status').textContent = 'SOLVED — token captured';
      document.title = 'SOLVED';
    }
  } catch (e) {}
}, 300);
</script></body></html>`;
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { server, url: `http://127.0.0.1:${server.address().port}/` };
  }

  async createTask({ websiteUrl, siteKey }) {
    if (this._browser) {
      try { await this._browser.close(); } catch (_) { /* ignore */ }
      this._browser = null;
    }
    if (this._server) {
      try { this._server.close(); } catch (_) { /* ignore */ }
      this._server = null;
    }
    this._token = null;

    const playwright = require('playwright');
    const { server, url } = await this._serveHarness(siteKey);
    this._server = server;

    const launchOpts = { headless: false };
    const pxy = this._playwrightProxy();
    if (pxy) launchOpts.proxy = pxy;

    const browser = await playwright.chromium.launch(launchOpts);
    this._browser = browser;
    const context = await browser.newContext({
      viewport: { width: 520, height: 620 },
      locale: 'en-US',
    });
    const page = await context.newPage();
    // Forward widget errors so a domain-lock is obvious in the bot's log.
    page.on('console', (m) => {
      if (m.type() === 'error') log(`  [hcaptcha-harness] ${m.text()}`);
    });
    page.on('pageerror', (e) => log(`  [hcaptcha-harness] page error: ${e.message}`));
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    this._page = page;

    console.log(
      `\n>>> MANUAL CAPTCHA — solve the widget in the Chromium window that just opened.\n` +
      `    It will close automatically once the token is captured.\n` +
      `    (proxy: ${this.taskProxy ? this.taskProxy : 'your real IP'})\n`
    );
    return `manual-${Date.now()}`;
  }

  async waitForSolution(/* taskId */ _taskId, timeoutMs = 180_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this._token) break;
      try {
        const tok = await this._page.evaluate(() => window.__manualToken || null);
        if (tok) { this._token = tok; break; }
      } catch (_) {
        // page closed or navigated — poll will surface it as a timeout below
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    const solved = !!this._token;
    try { await this._browser.close(); } catch (_) { /* ignore */ }
    if (this._server) { try { this._server.close(); } catch (_) { /* ignore */ } }
    this._browser = null;
    this._server = null;
    if (!solved) {
      throw new Error('Manual hCaptcha timed out — no checkbox solved in the Chromium window');
    }
    return { gRecaptchaResponse: this._token };
  }

  async report() {
    // Nothing to report to — no solving service was used.
  }
}

// --------------------------------------------------------------------------
// Capless solver client (https://capless.lol/docs)
//
// Capless is a synchronous one-shot API: POST /solve returns the token in the
// same response, no polling required. We expose the same {createTask,
// waitForSolution, report} surface as OnyxSolver so the captcha retry loop
// in createAccount() doesn't have to branch on provider.
//
// Note on coverage: capless lists Discord/Steam/Epic/Riot as pre-supported
// sites with tuned motion data. medal.tv is NOT on that list as of writing —
// solves may fall through their generic classifier and have a lower hit rate.
// Their docs say to request a new site you need a minimum $15 balance.
//
// "taskId" returned here is a synthetic uuid we mint locally so the caller's
// `solver.report(taskId, ...)` call stays a no-op (capless auto-refunds
// failed solves and has no report endpoint).
// --------------------------------------------------------------------------
class CaplessSolver {
  constructor({ apiKey, site, taskProxy = null }) {
    this.apiKey = apiKey;
    this.site = site || 'medal.tv';
    this.taskProxy = taskProxy;
    this.http = axios.create({ timeout: 180_000, validateStatus: () => true });
    // Stash the solved token between createTask()/waitForSolution() so the
    // OnyxSolver-shaped call pattern still works without re-issuing the call.
    this._pending = new Map();
  }

  async createTask({ websiteUrl, siteKey }) {
    // capless requires the proxy in http://user:pass@host:port form. Our
    // normalizeProxy() already returns that shape, so pass through verbatim
    // when present. Capless rejects requests without a proxy.
    if (!this.taskProxy) {
      throw new Error('CaplessSolver requires a proxy (set ONYX_USE_TASK_PROXY=1 / always-on)');
    }
    // The `site` field is the bare domain. websiteUrl (e.g. https://medal.tv/)
    // is only used as a fallback to derive the host if site wasn't set.
    let siteHost = this.site;
    if (!siteHost) {
      try { siteHost = new URL(websiteUrl).host; } catch (_) { siteHost = 'medal.tv'; }
    }
    const body = {
      type: 'hcaptcha',
      site: siteHost,
      sitekey: siteKey,
      proxy: this.taskProxy,
    };
    const r = await this.http.post(`${CAPLESS_BASE}/solve`, body, {
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
      },
    });
    const data = r.data || {};
    if (r.status !== 200 || data.status !== 'success' || !data.token) {
      const err = data.error || JSON.stringify(data).slice(0, 400);
      throw new Error(`Capless solve failed (http ${r.status}): ${err}`);
    }
    const taskId = `capless-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this._pending.set(taskId, {
      gRecaptchaResponse: data.token,
      userAgent: data.user_agent,
      cost: 0.01,
      balance: data.balance,
    });
    return taskId;
  }

  async waitForSolution(taskId /*, timeoutMs */) {
    const sol = this._pending.get(taskId);
    if (!sol) throw new Error(`CaplessSolver: unknown taskId ${taskId}`);
    this._pending.delete(taskId);
    return sol;
  }

  async report(/* taskId, result */) {
    // capless auto-refunds failures; no report endpoint exists.
  }
}

// --------------------------------------------------------------------------
// NopeCHA token solver (https://nopecha.com/api-reference/#postHcaptchaToken)
//
// NopeCHA's "Token hCaptcha" endpoint is asynchronous: POST returns a job id,
// then GET polls until the token is ready. 409 = job still in progress; their
// docs recommend ~500ms between polls. We wrap that flow in the same
// {createTask, waitForSolution, report} surface as OnyxSolver/CaplessSolver so
// the retry loop in createAccount() stays provider-blind.
//
// Auth: `Authorization: Basic <key>` per their examples (it's literal "Basic"
// + raw key, NOT base64). The `?key=<key>` query-param alternative also works.
// The `proxy` field is OPTIONAL for hCaptcha tokens but we always pass it so
// the solver IP matches the medal.tv signup IP; mismatched IPs sometimes
// invalidate the token at use-site.
// --------------------------------------------------------------------------
class NopeCHASolver {
  constructor({ apiKey, taskProxy = null, pollMs = 750, timeoutMs = 180_000 }) {
    this.apiKey = apiKey;
    this.taskProxy = taskProxy;
    this.pollMs = pollMs;
    this.timeoutMs = timeoutMs;
    this.http = axios.create({ timeout: 60_000, validateStatus: () => true });
    this._authHeaders = {
      'content-type': 'application/json',
      authorization: `Basic ${this.apiKey}`,
    };
  }

  // Parse a normalised proxy URL (http://user:pass@host:port) into the
  // structured object NopeCHA wants. Returns null when no proxy is set.
  _proxyObject() {
    if (!this.taskProxy) return null;
    try {
      const u = new URL(this.taskProxy);
      const scheme = (u.protocol || 'http:').replace(':', '');
      const port = parseInt(u.port, 10);
      if (!u.hostname || !port) return null;
      const out = { scheme, host: u.hostname, port };
      if (u.username) out.username = decodeURIComponent(u.username);
      if (u.password) out.password = decodeURIComponent(u.password);
      return out;
    } catch (_) {
      return null;
    }
  }

  async createTask({ websiteUrl, siteKey }) {
    const body = {
      sitekey: siteKey,
      url: websiteUrl,
    };
    const proxy = this._proxyObject();
    if (proxy) body.proxy = proxy;

    const r = await this.http.post(`${NOPECHA_BASE}/v1/token/hcaptcha`, body, {
      headers: this._authHeaders,
    });
    const data = r.data || {};
    if (r.status !== 200 || !data.data) {
      throw new Error(
        `NopeCHA submit failed (http ${r.status}): ${JSON.stringify(data).slice(0, 400)}`
      );
    }
    return data.data; // job id
  }

  async waitForSolution(taskId) {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const r = await this.http.get(`${NOPECHA_BASE}/v1/token/hcaptcha`, {
        headers: this._authHeaders,
        params: { id: taskId },
      });
      const data = r.data || {};
      if (r.status === 200 && data.data) {
        // NopeCHA doesn't tell us the per-solve cost; use $0 so logs don't
        // mislead. Real billing is checked via /v1/status separately.
        return { gRecaptchaResponse: data.data, cost: 0 };
      }
      if (r.status === 409) {
        // Job still in progress per their docs; back off and retry.
        await new Promise((res) => setTimeout(res, this.pollMs));
        continue;
      }
      throw new Error(
        `NopeCHA poll failed (http ${r.status}): ${JSON.stringify(data).slice(0, 400)}`
      );
    }
    throw new Error('NopeCHA timed out waiting for token');
  }

  async report(/* taskId, result */) {
    // NopeCHA has no report endpoint; bad-token feedback is implicit (use the
    // /v1/status balance to monitor refunds).
  }
}

// --------------------------------------------------------------------------
// RezoSolver token solver (https://rezosolver.com/docs.html)
//
// Async POST /createtask → taskId, then poll POST /gettaskresult until
// status=success (token in `uuid`) or status=error. Same {createTask,
// waitForSolution, report} surface as the other providers.
// --------------------------------------------------------------------------
class RezoSolver {
  constructor({
    apiKey,
    taskProxy = null,
    apiProxy = null,
    pollMs = 1500,
    timeoutMs = 180_000,
    userAgent = null,
  }) {
    this.apiKey = apiKey;
    this.taskProxy = taskProxy;
    this.apiProxy = apiProxy;
    this.pollMs = pollMs;
    this.timeoutMs = timeoutMs;
    this.userAgent = userAgent;
    const agent = proxyAgent(apiProxy);
    this.http = axios.create({
      timeout: 60_000,
      validateStatus: () => true,
      ...(agent ? { httpAgent: agent, httpsAgent: agent, proxy: false } : {}),
    });
  }

  _isRateLimited(status, data) {
    return status === 429 || (data && data.errorCode === 'RATE_LIMITED');
  }

  async createTask({ websiteUrl, siteKey }) {
    const task = {
      site_url: websiteUrl,
      site_key: siteKey,
    };
    if (this.taskProxy) task.proxy = this.taskProxy;
    if (this.userAgent) task.ua = this.userAgent;

    const r = await this.http.post(
      `${REZO_BASE}/createtask`,
      { clientKey: this.apiKey, task },
      { headers: { 'Content-Type': 'application/json' } }
    );
    const data = r.data || {};
    if (this._isRateLimited(r.status, data)) {
      throw new Error(`RezoSolver rate limited: ${JSON.stringify(data).slice(0, 200)}`);
    }
    if (!data.taskId) {
      throw new Error(
        `RezoSolver createTask failed (http ${r.status}): ${JSON.stringify(data).slice(0, 400)}`
      );
    }
    return data.taskId;
  }

  async waitForSolution(taskId) {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const r = await this.http.post(
        `${REZO_BASE}/gettaskresult`,
        { clientKey: this.apiKey, taskId },
        { headers: { 'Content-Type': 'application/json' } }
      );
      const data = r.data || {};
      if (this._isRateLimited(r.status, data)) {
        // Transient per-IP cap during poll — back off and retry within timeout.
        await new Promise((res) => setTimeout(res, this.pollMs * 2));
        continue;
      }
      if (data.status === 'success' && data.uuid) {
        return { gRecaptchaResponse: data.uuid, cost: data.cost || 0 };
      }
      if (data.status === 'error') {
        throw new Error(
          `RezoSolver error: ${data.errorCode || 'unknown'} — ` +
            `${data.errorDescription || JSON.stringify(data).slice(0, 200)}`
        );
      }
      if (data.status === 'solving') {
        await new Promise((res) => setTimeout(res, this.pollMs));
        continue;
      }
      throw new Error(
        `RezoSolver poll unexpected (http ${r.status}): ${JSON.stringify(data).slice(0, 400)}`
      );
    }
    throw new Error('RezoSolver timed out waiting for token');
  }

  async report(/* taskId, result */) {
    // RezoSolver has no report endpoint in their public docs.
  }
}

// --------------------------------------------------------------------------
// VoidSolver token solver (https://voidsolver.tech/docs)
//
// Standard: POST /createtask → taskId, poll GET /gettaskresult?taskid= until
// status=success (token in solvedToken). Advanced: POST /solve-advance → taskId,
// poll GET /solve-advance/task/:taskid (token in uuid).
//
// Unlike RezoSolver, VoidSolver is a generic hCaptcha API — any site_url +
// site_key is accepted. Docs recommend polling no faster than every 2s.
// Auth: Authorization: Bearer <key>
// --------------------------------------------------------------------------
class VoidSolver {
  constructor({
    apiKey,
    taskProxy = null,
    pollMs = 2000,
    timeoutMs = 180_000,
    userAgent = null,
    useAdvanced = false,
  }) {
    this.apiKey = apiKey;
    this.taskProxy = taskProxy;
    this.pollMs = Math.max(pollMs, 2000);
    this.timeoutMs = timeoutMs;
    this.userAgent = userAgent;
    this.useAdvanced = useAdvanced;
    this.http = axios.create({ timeout: 60_000, validateStatus: () => true });
    this._authHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };
    // taskId → 'standard' | 'advanced' so waitForSolution knows which poll URL.
    this._taskMode = new Map();
  }

  _fail(action, status, data) {
    throw new Error(
      `VoidSolver ${action} failed (http ${status}): ${JSON.stringify(data).slice(0, 400)}`
    );
  }

  async createTask({ websiteUrl, siteKey }) {
    if (this.useAdvanced) {
      const body = { url: websiteUrl, sitekey: siteKey };
      if (this.taskProxy) body.proxy = this.taskProxy;
      if (this.userAgent) body.user_agent = this.userAgent;
      const r = await this.http.post(`${VOID_BASE}/solve-advance`, body, {
        headers: this._authHeaders,
      });
      const data = r.data || {};
      if (r.status >= 400 || data.error || !data.taskId) {
        this._fail('createTask (advanced)', r.status, data);
      }
      this._taskMode.set(data.taskId, 'advanced');
      return data.taskId;
    }

    const body = { site_url: websiteUrl, site_key: siteKey };
    if (this.taskProxy) body.proxy = this.taskProxy;
    const r = await this.http.post(`${VOID_BASE}/createtask`, body, {
      headers: this._authHeaders,
    });
    const data = r.data || {};
    if (r.status >= 400 || data.error || !data.taskId) {
      this._fail('createTask', r.status, data);
    }
    this._taskMode.set(data.taskId, 'standard');
    return data.taskId;
  }

  async waitForSolution(taskId) {
    const mode = this._taskMode.get(taskId) || (this.useAdvanced ? 'advanced' : 'standard');
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const r = mode === 'advanced'
        ? await this.http.get(`${VOID_BASE}/solve-advance/task/${encodeURIComponent(taskId)}`, {
            headers: { Authorization: `Bearer ${this.apiKey}` },
          })
        : await this.http.get(`${VOID_BASE}/gettaskresult`, {
            headers: { Authorization: `Bearer ${this.apiKey}` },
            params: { taskid: taskId },
          });
      const data = r.data || {};
      if (r.status === 429) {
        await new Promise((res) => setTimeout(res, this.pollMs * 2));
        continue;
      }
      if (r.status >= 400 && data.error) {
        this._fail('getTaskResult', r.status, data);
      }
      if (data.status === 'success') {
        const token = mode === 'advanced' ? data.uuid : data.solvedToken;
        if (!token) {
          this._fail('getTaskResult', r.status, data);
        }
        this._taskMode.delete(taskId);
        return { gRecaptchaResponse: token, cost: data.cost || 0 };
      }
      if (data.status === 'solving' || data.status === 'pending' || !data.status) {
        await new Promise((res) => setTimeout(res, this.pollMs));
        continue;
      }
      if (data.status === 'error' || data.error) {
        this._fail('getTaskResult', r.status, data);
      }
      this._fail('getTaskResult (unexpected)', r.status, data);
    }
    throw new Error('VoidSolver timed out waiting for token');
  }

  async report(/* taskId, result */) {
    // VoidSolver has no report endpoint in their public docs.
  }
}

function makeCaptchaSolver(cfg, proxy) {
  if (cfg.captchaProvider === 'manual') {
    return new ManualSolver({ taskProxy: proxy });
  }
  if (cfg.captchaProvider === 'nopecha') {
    return new NopeCHASolver({
      apiKey: cfg.nopechaKey,
      taskProxy: cfg.nopechaUseTaskProxy ? proxy : null,
      pollMs: cfg.nopechaPollMs,
      timeoutMs: cfg.nopechaTimeoutMs,
    });
  }
  if (cfg.captchaProvider === 'rezosolver') {
    return new RezoSolver({
      apiKey: cfg.rezoKey,
      taskProxy: cfg.rezoUseTaskProxy ? proxy : null,
      apiProxy: cfg.rezoUseApiProxy ? proxy : null,
      pollMs: cfg.rezoPollMs,
      timeoutMs: cfg.rezoTimeoutMs,
      userAgent: MEDAL_UA,
    });
  }
  if (cfg.captchaProvider === 'voidsolver') {
    return new VoidSolver({
      apiKey: cfg.voidKey,
      taskProxy: cfg.voidUseTaskProxy ? proxy : null,
      pollMs: cfg.voidPollMs,
      timeoutMs: cfg.voidTimeoutMs,
      userAgent: MEDAL_UA,
      useAdvanced: cfg.voidUseAdvanced,
    });
  }
  if (cfg.captchaProvider === 'capless') {
    return new CaplessSolver({ apiKey: cfg.caplessKey, site: cfg.caplessSite, taskProxy: proxy });
  }
  const taskProxy = cfg.onyxUseTaskProxy ? proxy : null;
  return new OnyxSolver({ apiKey: cfg.onyxKey, taskProxy });
}

// --------------------------------------------------------------------------
// Amplitude payload builders
// --------------------------------------------------------------------------
const COMMON_EVENT_PROPS = {
  platform: 'desktop',
  electronVersion: APP_VERSION,
  electronVersionNumerical: ELECTRON_VERSION_NUM,
  recorderVersion: RECORDER_VERSION,
  recorderVersionNumerical: RECORDER_VERSION_NUM,
  environment: 'production',
  route: 'medal://login',
  appPath: 'login',
};

function ampEventBase(fp, userId) {
  return {
    user_id: userId,
    device_id: fp.deviceId,
    session_id: fp.sessionId,
    time: Date.now(),
    app_version: APP_VERSION,
    platform: 'Web',
    language: 'en-US',
    ip: '$remote',
    insert_id: uuidv4(),
    library: 'amplitude-ts/2.10.0',
    user_agent: MEDAL_UA,
  };
}

function buildOnboardingStartedBatch(fp) {
  const e1 = {
    ...ampEventBase(fp, null),
    event_type: 'onboardingStarted',
    event_properties: { pageType: '', ...COMMON_EVENT_PROPS, accountType: 'Guest' },
    event_id: nextEventId(fp),
  };
  const e2 = {
    ...ampEventBase(fp, null),
    event_type: 'onboarding',
    event_properties: {
      pageType: '',
      stepType: 'email',
      ...COMMON_EVENT_PROPS,
      accountType: 'Guest',
    },
    event_id: nextEventId(fp),
  };
  return {
    api_key: AMPLITUDE_API_KEY,
    events: [e1, e2],
    options: {},
    client_upload_time: isoUtcNowMs(),
    request_metadata: { sdk: { metrics: { histogram: {} } } },
  };
}

function buildPostSignupBatch(fp, userId, birthYear) {
  const events = [];
  events.push({
    ...ampEventBase(fp, null),
    event_type: '$identify',
    user_properties: { $set: { yearOfBirth: birthYear } },
    event_id: nextEventId(fp),
  });
  events.push({
    ...ampEventBase(fp, null),
    event_type: 'updateSetting',
    event_properties: {
      pageType: '',
      setting: 'yearOfBirth',
      value: birthYear,
      from: 'onboarding',
      ...COMMON_EVENT_PROPS,
      accountType: 'Guest',
    },
    event_id: nextEventId(fp),
  });
  events.push({
    ...ampEventBase(fp, userId),
    event_type: 'onboarding',
    event_properties: {
      pageType: '',
      stepType: 'mobileSync',
      ...COMMON_EVENT_PROPS,
      accountType: 'User',
    },
    event_id: nextEventId(fp),
  });
  events.push({
    ...ampEventBase(fp, userId),
    event_type: '$identify',
    user_properties: {
      $set: {
        accountType: 'User',
        buildType: 'production',
        desktopElectronVersion: APP_VERSION,
        electronVersionNumerical: ELECTRON_VERSION_NUM,
        desktopRecorderVersion: RECORDER_VERSION,
        recorderVersionNumerical: RECORDER_VERSION_NUM,
        versions: {
          electron: '40.1.0',
          node: '24.11.1',
          chrome: '144.0.7559.96',
          v8: '14.4.258.22-electron.0',
        },
        enableICYMI: false,
        kbmOverlayEnabled: false,
        kbmOverlayLayout: 'qwerty_truncated',
        webcamOverlayEnabled: false,
        medalStaff: false,
        medalResearchGroup: false,
        roles: [],
      },
    },
    event_id: nextEventId(fp),
  });
  return {
    api_key: AMPLITUDE_API_KEY,
    events,
    options: {},
    client_upload_time: isoUtcNowMs(),
    request_metadata: { sdk: { metrics: { histogram: {} } } },
  };
}

function buildSecondaryIdentifyBatch(fp, userId) {
  const e = {
    ...ampEventBase(fp, userId),
    session_id: fp.sessionIdSecondary,
    user_agent: AMPLITUDE_UA_BROWSER,
    event_type: '$identify',
    user_properties: { $set: { accountType: 'User', platform: 'desktop' } },
    event_id: 2,
  };
  return {
    api_key: AMPLITUDE_API_KEY,
    events: [e],
    options: {},
    client_upload_time: isoUtcNowMs(),
    request_metadata: { sdk: { metrics: { histogram: {} } } },
  };
}

function buildFinalIdentifyBatch(fp, userId) {
  const e = {
    ...ampEventBase(fp, userId),
    event_type: '$identify',
    user_properties: { $set: { accountType: 'User', platform: 'desktop' } },
    event_id: nextEventId(fp),
  };
  return {
    api_key: AMPLITUDE_API_KEY,
    events: [e],
    options: {},
    client_upload_time: isoUtcNowMs(),
    request_metadata: { sdk: { metrics: { histogram: {} } } },
  };
}

// --------------------------------------------------------------------------
// Flow
// --------------------------------------------------------------------------
// --- Colored logging (ANSI escapes, no deps) -----------------------------
// Color output:
// - default: enabled only on TTY (interactive terminal)
// - FORCE_COLOR=1/true/yes: force-enable even under PM2/file logs
// - NO_COLOR=1 (or any non-empty): hard-disable
const FORCE_COLOR = /^(1|true|yes)$/i.test(String(process.env.FORCE_COLOR || '').trim());
const NO_COLOR = String(process.env.NO_COLOR || '').trim() !== '';
const COLOR_ENABLED = (process.stdout.isTTY || FORCE_COLOR) && !NO_COLOR;
const C = (code) => (s) => COLOR_ENABLED ? `\x1b[${code}m${s}\x1b[0m` : s;
const c = {
  dim: C('2'),
  bold: C('1'),
  red: C('31'),
  green: C('32'),
  yellow: C('33'),
  blue: C('34'),
  magenta: C('35'),
  cyan: C('36'),
  gray: C('90'),
};

// Classifies a log line by keywords and returns a colored version.
function colorizeMessage(msg) {
  const s = String(msg);

  // "done. ok=N fail=M" — green if no fails, red otherwise
  const doneMatch = s.match(/^done\. ok=(\d+) fail=(\d+)/);
  if (doneMatch) return doneMatch[2] === '0' ? c.green(c.bold(s)) : c.red(c.bold(s));

  // WARN first (non-fatal / WARNING take priority over generic "failed")
  if (/\b(non-fatal|WARNING|cancel|ban\b)/i.test(s)) return c.yellow(s);

  // HARD ERROR / FAIL
  if (/\b(FAIL|ERROR|failed|error|invalid)\b/.test(s) ||
      /\b(failed|error)\b/.test(s.toLowerCase()))
    return c.red(s);

  // SUCCESS signals
  if (/\b(ACCOUNT CREATED|verified|published|enrolled|saved to|ok\b|clip: published)/i.test(s))
    return c.green(s);

  // INFO highlights / section headers
  if (/^===|^---/.test(s)) return c.bold(c.cyan(s));

  // Step labels (cyan for context)
  if (/^\s*(clip:|5sim:|onyx|quest|medal|amplitude|firestore|POST |GET |PUT )/i.test(s))
    return c.cyan(s);

  return s;
}

function log(...args) {
  const ts = c.gray(`[${new Date().toISOString()}]`);
  const formatted = args.map((a) =>
    typeof a === 'string' ? colorizeMessage(a) : a
  );
  const ctx = workerContext.getStore();
  if (ctx && ctx.tag) {
    console.log(ts, ctx.tag, ...formatted);
  } else {
    console.log(ts, ...formatted);
  }
}

// Verbose-only logger. Silent unless --verbose / MEDAL_VERBOSE=1 is set.
// Use for routine "step succeeded" chatter (amplitude pings, intermediate
// API calls, GCS upload sub-steps, etc.). If a step ACTUALLY fails it
// throws an error which the caller logs at the normal level — so muting
// the success spam loses nothing operationally.
let _verboseLogging = false;
function setVerboseLogging(v) { _verboseLogging = !!v; }
function vlog(...args) {
  if (_verboseLogging) log(...args);
}

async function sendAmplitude(client, payload, label) {
  try {
    await client.postJson(AMPLITUDE_URL, payload, client.amplitudeHeaders());
    vlog(`amplitude ${label} ok`);
  } catch (e) {
    vlog(`amplitude ${label} failed (non-fatal): ${e.message}`);
  }
}

async function createAccount({ cfg, args, proxy }) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cfg.sitekey)) {
    throw new Error(
      `MEDAL_HCAPTCHA_SITEKEY doesn't look like a UUID sitekey: ${cfg.sitekey}`
    );
  }
  const id = newIdentity(cfg.emailDomain);
  const fp = newDeviceFingerprint();
  const client = new MedalClient({ proxy, timezone: cfg.timezone });
  // Minimal record available from the start so we can write a failed-account
  // entry even when the failure happens before account creation (e.g. captcha).
  const partialRecord = {
    email: id.email,
    username: id.username,
    password: id.password,
    birthYear: id.birthYear.toString(),
    proxy: proxy || null,
    attemptedAt: new Date().toISOString(),
  };

  log(
    `new identity  email=${id.email}  user=${id.username}  ` +
      `dob=${id.birthMonth}/${id.birthDay}/${id.birthYear}` +
      (proxy ? `  proxy=${maskProxy(proxy)}` : '')
  );

  // 1. analytics: onboardingStarted + onboarding(email)
  if (args.analytics) {
    await sendAmplitude(
      client,
      buildOnboardingStartedBatch(fp),
      'onboardingStarted'
    );
  }

  // 2. email availability
  const emailCheck = await client.postJson(
    `${MEDAL_API}/users/email`,
    { email: id.email },
    client.medalHeaders()
  );
  vlog(
    `email check -> exists=${emailCheck.exists} valid=${emailCheck.valid}`
  );
  if (emailCheck.exists || emailCheck.valid === false) {
    throw new Error(
      `email rejected by Medal: ${JSON.stringify(emailCheck)}`
    );
  }

  const userCheck = await client.postJson(
    `${MEDAL_API}/users/username`,
    { username: id.username },
    client.medalHeaders()
  );
  vlog(
    `username check -> exists=${userCheck.exists} valid=${userCheck.valid}`
  );
  if (userCheck.exists || userCheck.valid === false) {
    throw new Error(
      `username rejected by Medal: ${JSON.stringify(userCheck)}`
    );
  }

  const pwCheck = await client.postJson(
    `${MEDAL_API}/authentication/password`,
    { password: id.password, relatedWords: [id.email] },
    client.medalHeaders()
  );
  vlog(
    `password check -> valid=${pwCheck.valid} entropy=${pwCheck.entropy}`
  );
  if (pwCheck.valid === false) {
    throw new Error(
      `password rejected by Medal: ${JSON.stringify(pwCheck)}`
    );
  }

  // 5. solve hCaptcha (retry up to cfg.captchaRetries times on transient solver failures).
  // Provider is chosen at config time (capless | onyx); both share the same
  // {createTask, waitForSolution, report} surface so this loop is provider-blind.
  const solver = makeCaptchaSolver(cfg, proxy);
  const providerLabel = (
    cfg.captchaProvider === 'nopecha' ? 'NopeCHA' :
    cfg.captchaProvider === 'rezosolver' ? 'RezoSolver' :
    cfg.captchaProvider === 'voidsolver' ? 'VoidSolver' :
    cfg.captchaProvider === 'capless' ? 'Capless' :
    cfg.captchaProvider === 'manual' ? 'Manual (Chromium)' :
    'OnyxSolver'
  );
  let captchaToken = null;
  let taskId = null;
  const CAPTCHA_RETRIES = cfg.captchaRetries;
  for (let attempt = 1; attempt <= CAPTCHA_RETRIES; attempt++) {
    if (attempt > 1) {
      const delay = Math.min(attempt * 2000, 15000);
      log(`retrying hCaptcha (attempt ${attempt}/${CAPTCHA_RETRIES}) after ${delay}ms...`);
      await new Promise((res) => setTimeout(res, delay));
    }
    vlog(`requesting hCaptcha from ${providerLabel} (sitekey=${cfg.sitekey})...`);
    try {
      taskId = await solver.createTask({
        websiteUrl: cfg.captchaPage,
        siteKey: cfg.sitekey,
      });
      vlog(`${providerLabel} taskId=${taskId}`);
      const solution = await solver.waitForSolution(taskId);
      captchaToken = solution.gRecaptchaResponse;
      const costStr = solution.cost != null ? ` cost=$${solution.cost}` : '';
      vlog(
        `${providerLabel} solved.${costStr} token=${captchaToken.slice(0, 48)}...`
      );
      break;
    } catch (e) {
      log(`${providerLabel} attempt ${attempt} failed: ${e.message}`);
      if (attempt === CAPTCHA_RETRIES) {
        const err = Object.assign(e, { failReason: 'captcha_exhausted' });
        appendFailedAccount(cfg.failedAccountsFile, partialRecord, 'captcha_exhausted', args);
        throw err;
      }
    }
  }

  // 6. final account create
  const created = await client.postJson(
    `${MEDAL_API}/users`,
    {
      email: id.email,
      userName: id.username,
      password: id.password,
      captchaResponse: captchaToken,
      birthYear: id.birthYear.toString(),
    },
    client.medalHeaders()
  );

  if (!created || !created.user || !created.auth || !created.auth.key) {
    await solver.report(taskId, 'invalid');
    throw new Error(
      `account create failed: ${JSON.stringify(created).slice(0, 500)}`
    );
  }

  await solver.report(taskId, 'success');
  log(
    `ACCOUNT CREATED  userId=${created.user.userId}  authKey=${created.auth.key.slice(0, 12)}...`
  );

  const userId = created.user.userId;
  const authKey = created.auth.key;
  const authHeader = `${userId},${authKey}`;

  let syncToken = null;
  let firestoreToken = null;

  // 7. authentication sync (session token)
  try {
    const sync = await client.postJson(
      `${MEDAL_API}/authentication/sync`,
      {},
      client.medalHeaders({ 'X-Authentication': authHeader })
    );
    syncToken = sync && sync.token ? sync.token : null;
    vlog(`sync ok token=${syncToken ? syncToken.slice(0, 16) + '...' : 'none'}`);
  } catch (e) {
    vlog(`sync failed (non-fatal): ${e.message}`);
  }

  // 8. referrals (404 expected, fire anyway to match client behaviour)
  try {
    const { status } = await client.getJson(
      `${MEDAL_API}/users/${userId}/referrals`,
      client.medalHeaders({ 'X-Authentication': authHeader })
    );
    vlog(`referrals GET -> ${status}`);
  } catch (_) {
    /* noop */
  }

  // 9. firestore auth
  if (args.analytics) {
    try {
      const r = await client.postJson(
        FIRESTORE_AUTH_URL,
        { id: userId, key: authKey },
        {
          Accept: '*/*',
          'Accept-Encoding': 'gzip, deflate, br, zstd',
          'Accept-Language': 'en-US',
          Connection: 'keep-alive',
          'Content-Type': 'application/json',
          Host: 'firestore-auth.medal.tv',
          'sec-ch-ua': '"Not(A:Brand";v="8", "Chromium";v="144"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'cross-site',
          'User-Agent': MEDAL_UA,
        }
      );
      firestoreToken = r && r.token ? r.token : null;
      vlog(
        `firestore auth ok token=${firestoreToken ? firestoreToken.slice(0, 20) + '...' : 'none'}`
      );
    } catch (e) {
      vlog(`firestore auth failed (non-fatal): ${e.message}`);
    }
  }

  // 10. post-signup analytics
  if (args.analytics) {
    await sendAmplitude(
      client,
      buildPostSignupBatch(fp, userId, id.birthYear.toString()),
      'post-signup'
    );
    await sendAmplitude(
      client,
      buildSecondaryIdentifyBatch(fp, userId),
      'secondary-identify'
    );
    await sendAmplitude(
      client,
      buildFinalIdentifyBatch(fp, userId),
      'final-identify'
    );
  }

  const record = {
    email: id.email,
    username: id.username,
    password: id.password,
    birthYear: id.birthYear.toString(),
    userId,
    authKey,
    syncToken,
    firestoreToken,
    proxy: proxy || null,
    createdAt: new Date().toISOString(),
  };

  // 11. OPTIONAL post-signup: enroll DonutSMP quest + phone verification
  if (args.enrollQuest && args.verifyPhone) {
    try {
      await enrollQuest({ client, authHeader, questId: cfg.questId });
    } catch (e) {
      vlog(`quest enroll failed (non-fatal): ${e.message}`);
    }
  }

  if (args.verifyPhone) {
    try {
      const phoneResult = await verifyPhone({
        cfg,
        client,
        authHeader,
        userId,
      });
      Object.assign(record, phoneResult);
    } catch (e) {
      log(`phone verification FAILED: ${e.message}`);
      record.phoneVerifyError = e.message;
      // ALWAYS bail when phone verification was requested but failed.
      // Without a verified phone the quest claim is guaranteed to be
      // rejected with "Phone verification required", and the clip upload
      // + claim attempt would just burn an OnyxSolver/clip slot for nothing.
      const reason = e.failReason || 'phone_verify_failed';
      appendFailedAccount(cfg.failedAccountsFile, record, reason, args);
      if (!e.failReason) e.failReason = reason;
      throw e; // bubble so the worker loop counts it as a failure
    }
  }

  if (args.uploadClip) {
    try {
      const clipResult = await uploadClip({
        cfg,
        userId,
        authKey,
        clipPath: args.clipPath || null,
        log,
        proxy,
      });
      record.clipId = clipResult.contentId;
      record.clipUrl = clipResult.shareUrl;
      record.clipTaskId = clipResult.taskId;
    } catch (e) {
      log(`clip upload FAILED: ${e.message}`);
      record.clipUploadError = e.message;
    }
  }

  // Java-cookie mode: stamp the record with the cookie metadata so re-runs can
  // skip this account (javaCookieFile is the authoritative "already done" key).
  if (args.javaCookieInfo) {
    record.mode = 'java';
    record.javaCookieFile = args.javaCookieInfo.fileName;
    record.javaIgnHint = args.javaCookieInfo.ignHint;
    record.javaSession = args.javaCookieInfo.sessionLabel;
    record.javaCookieCount = args.javaCookieInfo.cookieCount;
  }

  // Persist. The bot never submits a quest claim here — reward redemption is
  // done in-game by the connected Minecraft account. A fully created + phone-
  // verified account is always useful, so it is appended unconditionally —
  // EXCEPT when the java flow asked us to defer finalization (deferAppend), in
  // which case the caller (runJavaFlow) first links the Microsoft/Minecraft
  // identity and appends the enriched record itself.
  if (!args.deferAppend) {
    appendAccount(cfg.accountsFile, record);
    vlog(`saved to ${path.basename(cfg.accountsFile)}`);
  } else {
    vlog('createAccount: persist deferred (java flow will finalize)');
  }
  return record;
}

// --------------------------------------------------------------------------
// --------------------------------------------------------------------------
// Quest + phone verification
// --------------------------------------------------------------------------

async function enrollQuest({ client, authHeader, questId }) {
  vlog(`enrolling in quest ${questId}...`);
  const res = await client.postJson(
    `${MEDAL_API}/v2/quests/${questId}/enroll`,
    {}, // empty body, content-length:0 in the capture
    client.medalHeaders({ 'X-Authentication': authHeader })
  );
  const required = res?.userStatus?.phoneVerificationRequired;
  vlog(
    `quest enrolled. phoneVerificationRequired=${required} ` +
      `enrolledAt=${res?.userStatus?.enrolledAt || 'n/a'}`
  );
  return res;
}

/**
 * Claims a quest reward. Returns the raw HTTP status + body instead of
 * throwing on 4xx so the caller can record what Medal accepted. The `input`
 * string is submitted verbatim.
 */
/**
 * GET /api/v2/quests/:id — returns the quest config + the current user's
 * `userStatus.tasks` array, where each task has { taskId, requiredCount,
 * completedCount }. Medal exposes this so its UI can render the checklist;
 * we use it to confirm all tasks are done before POSTing to /reward/claim,
 * since some tasks are validated asynchronously on Medal's backend and may
 * lag behind the underlying state by a few minutes.
 */
async function getQuestStatus({ client, authHeader, questId }) {
  const url = `${MEDAL_API}/v2/quests/${questId}`;
  const r = await client.http.get(url, {
    headers: client.medalHeaders({ 'X-Authentication': authHeader }),
  });
  return { status: r.status, data: r.data };
}

/**
 * Summarises the task progress in a `getQuestStatus()` payload into a
 * compact { allDone, parts, raw } shape. `parts` is an array of
 * `${name}=${completedCount}/${requiredCount}` strings, in declaration
 * order, suitable for one-line log output.
 */
function summarizeQuestTasks(questData) {
  const cfgTasks = (questData?.config?.tasks) || [];
  const userTasks = (questData?.userStatus?.tasks) || [];
  const byId = Object.fromEntries(userTasks.map((t) => [t.taskId, t]));
  const parts = [];
  let allDone = cfgTasks.length > 0;
  for (const t of cfgTasks) {
    const u = byId[t.id] || { completedCount: 0, requiredCount: t.requiredCount };
    const done = (u.completedCount || 0) >= (u.requiredCount || 1);
    if (!done) allDone = false;
    const shortName = (t.name || t.id).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    parts.push(`${shortName}=${u.completedCount || 0}/${u.requiredCount || 1}`);
  }
  return { allDone, parts, raw: questData };
}

/**
 * Polls GET /quests/:id until every task in `userStatus.tasks` reports
 * `completedCount >= requiredCount`, or until `timeoutMs` elapses. Returns
 * { allDone, lastSummary, attempts, elapsedMs }. Used right before
 * claimQuestReward() to avoid the errorId 62 "Quest must have all tasks
 * completed" race where Medal hasn't yet re-registered task completion.
 */
async function waitForQuestTasksComplete({
  client,
  authHeader,
  questId,
  timeoutMs = 300_000,
  pollMs = 10_000,
  onTick = null,
}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const start = Date.now();
  let attempts = 0;
  let lastSummary = null;
  while (Date.now() - start < timeoutMs) {
    attempts += 1;
    const r = await getQuestStatus({ client, authHeader, questId });
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`quest status GET -> ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
    }
    lastSummary = summarizeQuestTasks(r.data);
    if (onTick) onTick({ attempt: attempts, summary: lastSummary, elapsedMs: Date.now() - start });
    if (lastSummary.allDone) {
      return { allDone: true, lastSummary, attempts, elapsedMs: Date.now() - start };
    }
    if (Date.now() - start + pollMs >= timeoutMs) break;
    await sleep(pollMs);
  }
  return { allDone: false, lastSummary, attempts, elapsedMs: Date.now() - start };
}

async function claimQuestReward({ client, authHeader, questId, input }) {
  const url = `${MEDAL_API}/v2/quests/${questId}/reward/claim`;
  const r = await client.http.post(
    url,
    { input },
    { headers: client.medalHeaders({ 'X-Authentication': authHeader }) }
  );
  return { status: r.status, data: r.data };
}

/**
 * Rewrites accounts.jsonl, merging `updates` into the record whose `userId`
 * matches. Returns true if a record was updated.
 */
function updateAccountRecord(filePath, userId, updates) {
  if (!fs.existsSync(filePath)) return false;
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  let hit = false;
  const out = lines.map((line) => {
    if (!line.trim()) return line;
    try {
      const rec = JSON.parse(line);
      if (rec.userId === userId) {
        hit = true;
        return JSON.stringify({ ...rec, ...updates });
      }
    } catch (_) {
      /* skip malformed lines */
    }
    return line;
  });
  fs.writeFileSync(filePath, out.join('\n'), 'utf8');
  return hit;
}

function loadAccountsFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// --------------------------------------------------------------------------
// Process-wide burned-phone tracker
// --------------------------------------------------------------------------
// 5sim has small operator pools (virtual53 ≈ 60 numbers). When the pool runs
// hot it hands the same phone to multiple concurrent workers in seconds.
// Medal anti-fraud then rate-limits THAT phone (errorId 402 / HTTP 429) for
// any new account that tries to attach it — even though each account has a
// different userId and a different upstream proxy IP. We track recently-bad
// phones here so:
//   1. Other workers don't waste a Medal POST on the same hot number.
//   2. Within one verifyPhone() call, we don't re-buy the same dead number.
// Entries auto-expire after BURNED_PHONE_TTL_MS so a number that cools off
// can be reused later. The map is module-scoped on purpose — it's shared
// across the worker pool because they all run in the same Node process.
const BURNED_PHONE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const burnedPhones = new Map(); // phone -> expiresAt (ms epoch)

function isPhoneBurned(phone) {
  const expiresAt = burnedPhones.get(phone);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    burnedPhones.delete(phone);
    return false;
  }
  return true;
}

function markPhoneBurned(phone, ttlMs = BURNED_PHONE_TTL_MS) {
  if (!phone) return;
  burnedPhones.set(phone, Date.now() + ttlMs);
  // Cheap opportunistic prune so the map can't grow unbounded.
  if (burnedPhones.size > 500) {
    const now = Date.now();
    for (const [p, exp] of burnedPhones) {
      if (exp < now) burnedPhones.delete(p);
    }
  }
}

/**
 * Buy a fresh, non-burned phone from 5sim. Walks the operator fallback list
 * (primary first, then FIVESIM_OPERATOR_FALLBACKS in order) and within each
 * operator allows up to REBUY_CAP retries when 5sim either:
 *   - returns "no free phones" (200 + string body — no exception),
 *   - returns a malformed order with no `phone` field,
 *   - returns a phone we recently marked as burned (Medal-throttled).
 * Returns { order, opUsed, phone } on success, or null when every operator
 * is dry of fresh numbers.
 */
async function buyFreshPhone({ sms, operators, country, product, attempt, retries, usedThisCall }) {
  const REBUY_CAP = 5;
  for (const op of operators) {
    for (let rebuy = 0; rebuy < REBUY_CAP; rebuy++) {
      vlog(
        `5sim: buying ${country}/${op}/${product} activation number... ` +
          `(attempt ${attempt}/${retries}${rebuy > 0 ? `, rebuy ${rebuy + 1}/${REBUY_CAP}` : ''})`
      );

      let order;
      try {
        order = await sms.buyActivation({ operator: op });
      } catch (e) {
        log(`5sim: operator ${op} buy failed: ${e.message.slice(0, 120)}`);
        break; // try next operator
      }

      // 5sim returns "no free phones" as a 200 with a string body (not an
      // error). Treat any non-object / phoneless response as out-of-stock
      // for THIS operator and fall through to the next one.
      if (!order || typeof order !== 'object' || typeof order.phone !== 'string' || !order.phone) {
        const body = typeof order === 'string' ? order : JSON.stringify(order).slice(0, 80);
        vlog(`5sim: operator ${op} no stock (body=${body})`);
        if (order && order.id) await safe(() => sms.cancelOrder(order.id), 'cancel-no-stock');
        break; // try next operator
      }

      const candidate = order.phone.startsWith('+') ? order.phone : `+${order.phone}`;

      if (usedThisCall.has(candidate)) {
        log(
          `5sim: ${op} re-issued already-tried phone ${candidate} this attempt — banning + re-buying`
        );
        await safe(() => sms.banOrder(order.id), 'ban-already-used');
        continue; // re-buy from same operator
      }

      if (isPhoneBurned(candidate)) {
        log(
          `5sim: ${op} returned recently-burned phone ${candidate} ` +
            `(another worker just got it rejected by Medal) — banning + re-buying`
        );
        await safe(() => sms.banOrder(order.id), 'ban-already-burned');
        continue; // re-buy from same operator
      }

      return { order, opUsed: op, phone: candidate };
    }
  }
  return null;
}

// ---- Dynamic 5sim operator ranking ----
// Process-wide cache of the /guest/prices RAW payload. We hit 5sim's
// /guest/prices endpoint AT MOST ONCE PER PROCESS LIFETIME for any given
// country/product pair — once a successful payload is cached, every
// worker (current and future, signup or expanded-pool fallback) reuses it
// forever. This is the user-requested behaviour: 5sim's /guest/prices is
// aggressively rate-limited, and stock/rate data is good enough for the
// operator-ranking heuristic even if hours stale (degradation is graceful
// because buyFreshPhone() catches "no stock" at buy time and rotates to
// the next ranked operator).
//
// Three layers of de-dup:
//
//   1. `payload`: the cached successful response. Once set, never
//      invalidated — every caller reads from RAM. The legacy
//      FIVESIM_PRICES_CACHE_TTL_MS env var is intentionally ignored.
//      Both standard and `expandPool` callers reuse the same payload
//      (they only differ in the FILTER step over the same data).
//   2. `inFlight`: a Promise representing the currently-running fetch.
//      Any worker that wants prices while a fetch is mid-flight just
//      `await`s this Promise instead of starting its own request. This
//      kills the 429 storm we saw when 100+ workers booted at once and
//      each independently fired /guest/prices.
//   3. `failedAt` + `_PRICES_FAIL_TTL_MS`: if the FIRST fetch fails
//      (e.g. 429 even on the lone pre-warm), we don't want every
//      subsequent verifyPhone() call to hammer 5sim trying to populate.
//      Negative-cache the failure for 15s; one worker retries when that
//      window elapses. Successful fetches override any stored failure.
let _pricesCache = {
  payload: null,
  key: null,
  inFlight: null,
  failedAt: 0,
};
const _PRICES_FAIL_TTL_MS = 15_000;

async function getPricesPayload(sms, cfg, _opts = {}) {
  const cacheKey = `${cfg.fivesim.country}|${cfg.fivesim.product}`;
  const now = Date.now();

  // Sticky success cache: once we have a payload for this country/product,
  // serve it forever. No TTL, no force-refetch — the user wants exactly
  // ONE /guest/prices call per process. Note: `_opts.force` is ignored
  // here on purpose — callers in verifyPhone use force when they've tried
  // every cached operator, but a cache refresh wouldn't help (stock
  // changes don't add untried operators) and would risk another 429.
  // Instead they fall through to the expandPool branch, which re-filters
  // the SAME payload with looser thresholds.
  if (_pricesCache.key === cacheKey && _pricesCache.payload) {
    return _pricesCache.payload;
  }

  // Fast path: a fetch for this country/product is already in flight —
  // wait on it instead of starting a duplicate request.
  if (_pricesCache.inFlight && _pricesCache.key === cacheKey) {
    return _pricesCache.inFlight;
  }

  // Cached recent failure — surface null without re-hitting 5sim. The
  // first worker absorbs the failure for everyone else for the next 15s,
  // then exactly one worker retries. Stops the 429 stampede when even the
  // pre-warm got rate-limited.
  if (
    _pricesCache.key === cacheKey &&
    _pricesCache.failedAt > 0 &&
    (now - _pricesCache.failedAt) < _PRICES_FAIL_TTL_MS
  ) {
    return null;
  }

  // Kick off the (probably one and only) fetch and stash the Promise so
  // any concurrent caller that arrives while we're awaiting can piggy-back.
  const fetchPromise = (async () => {
    try {
      const payload = await sms.prices({
        country: cfg.fivesim.country,
        product: cfg.fivesim.product,
      });
      _pricesCache = {
        payload,
        key: cacheKey,
        inFlight: null,
        failedAt: 0,
      };
      return payload;
    } catch (e) {
      log(
        `5sim: /guest/prices query failed (${e.message.slice(0, 120)}) — ` +
          `using static fallback (negative-cached for ${_PRICES_FAIL_TTL_MS / 1000}s)`
      );
      _pricesCache = {
        payload: _pricesCache.payload, // keep prior success if any
        key: cacheKey,
        inFlight: null,
        failedAt: Date.now(),
      };
      return null;
    }
  })();

  _pricesCache.inFlight = fetchPromise;
  _pricesCache.key = cacheKey;
  return fetchPromise;
}

/**
 * Pre-warm the /guest/prices cache once before workers spin up. Cheap
 * insurance against the boot-time stampede: with N workers all kicking off
 * verifyPhone() in roughly the same millisecond, EVERY one of them used to
 * fire its own /guest/prices and 5sim would 429-reject most. With a single
 * pre-warm here, the cache is populated before any worker asks for it, and
 * the in-flight de-dup in getPricesPayload() handles the rest.
 *
 * Safe to call without an API key (no-op) and safe if the request fails
 * (logged + workers fall back to the static list as today). Routes the
 * request through a random proxy from the pool when one is available so
 * the pre-warm itself doesn't burn 5sim's per-IP budget on the box's bare
 * IP just before workers start hitting /user/buy/activation.
 */
async function prewarmPricesCache(cfg, proxies = []) {
  if (!cfg.fivesim || !cfg.fivesim.apiKey) return;
  if (!cfg.fivesim.useDynamicRanking) return;
  try {
    const baseProxy = proxies && proxies.length
      ? proxies[Math.floor(Math.random() * proxies.length)]
      : null;
    const proxy = baseProxy ? rotateProxySessionId(baseProxy) : null;
    const sms = new FiveSim({ ...cfg.fivesim, proxy });
    const payload = await getPricesPayload(sms, cfg, { force: true });
    if (payload) {
      log(
        `5sim: pre-warmed /guest/prices cache (sticky for the entire process; ` +
          `via ${proxy ? 'proxy' : 'direct'})`
      );
    }
  } catch (e) {
    log(`5sim: pre-warm failed (${e.message.slice(0, 120)}) — workers will retry as needed`);
  }
}

/**
 * Query 5sim /guest/prices and return operators ranked by success rate
 * (desc), then cost (asc). Filters out:
 *   - 'any' (the wildcard that routes to whichever op has the most stock,
 *           which empirically is the LOWEST success rate one)
 *   - operators with count <= 0 (no live stock right now)
 *   - operators with rate < cfg.fivesim.minRate (default 10%)
 *   - operators with cost > cfg.fivesim.maxCost (if a ceiling was set)
 *
 * Returns an array of operator names. On API failure or empty result,
 * returns null so the caller can fall back to the configured static list.
 *
 * Single-flight + payload cache lives in getPricesPayload(); this function
 * is just the filter/sort layer over whatever payload that returned.
 */
async function rankOperatorsByLiveData(sms, cfg, opts = {}) {
  const payload = await getPricesPayload(sms, cfg, opts);
  if (!payload) return null;

  const opsObj = payload?.[cfg.fivesim.country]?.[cfg.fivesim.product];
  if (!opsObj || typeof opsObj !== 'object') {
    log(`5sim: /guest/prices returned unexpected payload — using static fallback`);
    return null;
  }

  // expandPool=true loosens the rate/cost/count filters so we can fall
  // back to lower-rate operators when the high-rate ones are all Medal-
  // blocked at the range level (errorId:37). The expanded floor
  // (FIVESIM_EXPANDED_MIN_RATE, default 1%) is still > 0 because
  // operators below that bar (e.g. 0.3% / 0.9%) will accept phones at
  // Medal but virtually NEVER deliver an SMS — burning 90s of poll time
  // per attempt for nothing. Anything that low is effectively a dead pool.
  const expandedMinRate = Math.max(0, cfg.fivesim.expandedMinRate);
  const minRate = opts.expandPool
    ? expandedMinRate
    : Math.max(0, cfg.fivesim.minRate);
  const maxCost = opts.expandPool
    ? Infinity
    : (cfg.fivesim.maxCost > 0 ? cfg.fivesim.maxCost : Infinity);
  const opCap = opts.expandPool
    ? Number.MAX_SAFE_INTEGER
    : Math.max(1, cfg.fivesim.maxOperators);

  // Step 1: collect every operator that has live stock right now. This is
  // the "what's actually available" universe — we apply rate/cost filters
  // on top of it next. Excludes the 'any' wildcard (routes to whichever op
  // has the most stock = empirically the LOWEST success rate one) and any
  // malformed entries.
  const allWithStock = Object.entries(opsObj)
    .filter(([op, info]) => {
      if (!op || op.toLowerCase() === 'any') return false;
      if (!info || typeof info !== 'object') return false;
      if (typeof info.count !== 'number' || info.count <= 0) return false;
      if (typeof info.rate !== 'number') return false;
      return true;
    })
    .map(([op, info]) => ({
      op,
      cost: typeof info.cost === 'number' ? info.cost : 0,
      count: info.count,
      rate: info.rate,
    }));

  if (allWithStock.length === 0) {
    log(`5sim: /guest/prices returned no in-stock operators — using static fallback`);
    return null;
  }

  // Step 2: apply the standard rate / cost filters and rank.
  const sortByRateThenCost = (a, b) => {
    if (b.rate !== a.rate) return b.rate - a.rate; // higher rate wins
    return a.cost - b.cost; // tie-break: cheaper wins
  };

  let candidates = allWithStock
    .filter((c) => c.rate >= minRate && c.cost <= maxCost)
    .sort(sortByRateThenCost)
    .slice(0, opCap);

  // Step 3: filter excluded everything → relax to "highest success-rate
  // operator with stock", regardless of the minRate threshold. Trying a
  // 4% / 3% / 1% operator from live data is strictly better than falling
  // through to a stale static list (the previous behaviour that frequently
  // routed orders to operators with no stock). User explicitly asked for
  // this: "use the highest successrate even if its 4% success rate".
  let relaxedReason = null;
  if (candidates.length === 0) {
    const relaxedByCost = allWithStock
      .filter((c) => c.cost <= maxCost)
      .sort(sortByRateThenCost)
      .slice(0, opCap);

    if (relaxedByCost.length > 0) {
      candidates = relaxedByCost;
      relaxedReason = `no in-stock op >=${minRate}%`;
    } else {
      // Cost ceiling rejected every in-stock op too — drop both filters.
      candidates = allWithStock.slice().sort(sortByRateThenCost).slice(0, opCap);
      relaxedReason = `no in-stock op >=${minRate}% within cost ceiling ${maxCost}`;
    }
  }

  if (candidates.length === 0) {
    log(`5sim: no usable operators on /guest/prices — using static fallback`);
    return null;
  }

  const summary = candidates
    .map((o) => `${o.op}=${o.rate.toFixed(1)}%/${o.count}/${o.cost}`)
    .join(' ');
  let label;
  if (relaxedReason) {
    label = ` (RELAXED — ${relaxedReason}; using best-available rate)`;
  } else if (opts.expandPool) {
    label = ' (EXPANDED pool)';
  } else {
    label = '';
  }
  log(`5sim: ranked operators by rate%/stock/cost${label} — ${summary}`);

  return candidates.map((c) => c.op);
}

/**
 * Build the operator list for a verifyPhone() invocation. When dynamic
 * ranking is enabled (default), live 5sim data drives the order. When the
 * API is unreachable or returns nothing useful, falls back to the static
 * [primary, ...fallbacks] list (with 'any' already stripped at config load).
 */
async function pickOperatorsForVerify(sms, cfg, opts = {}) {
  if (cfg.fivesim.useDynamicRanking || opts.expandPool) {
    const ranked = await rankOperatorsByLiveData(sms, cfg, opts);
    if (ranked && ranked.length > 0) return ranked;
  }
  // Last-resort fallback (only reached if dynamic ranking is disabled OR the
  // /prices API is unreachable). Strip 'any' as belt-and-braces in case it
  // crept back into FIVESIM_OPERATOR_FALLBACKS.
  const fallback = [cfg.fivesim.operator, ...cfg.fivesim.operatorFallbacks]
    .filter((o) => o && o.toLowerCase() !== 'any');
  if (fallback.length === 0) {
    throw new Error(
      'No 5sim operators available: /guest/prices unreachable AND ' +
      'no usable static operators. Check FIVESIM_API_KEY / network / FIVESIM_MIN_RATE.'
    );
  }
  return fallback;
}

/**
 * Full phone-verify flow using 5sim.net with burned-number auto-retry:
 *   Walk operators [primary, ...fallbacks]. For each operator:
 *     - Try up to FIVESIM_MAX_ATTEMPTS_PER_OPERATOR fresh numbers.
 *     - On consecutive failures (no SMS / 4xx / verification fail), rotate
 *       to the next operator instead of grinding more dead numbers from
 *       the same dud pool.
 *   Total attempts capped at FIVESIM_PHONE_RETRIES across all operators.
 *   For each attempt:
 *     1. Buy a fresh, non-burned UK activation number (product=medal) on
 *        the current operator only.
 *     2. POST the phone to /api/users/{id}/settings -> Medal triggers SMS.
 *        On 429 (Medal phone-throttle): mark phone burned, ban on 5sim,
 *        loop with a fresh number — the account is still good.
 *     3. Poll 5sim /user/check/{id} until SMS arrives OR per-attempt timeout.
 *     4. If SMS arrives: submit code to Medal, finish() on 5sim, return.
 *        If timeout / "Phone verification failed": ban + try a fresh number.
 */
async function verifyPhone({ cfg, client, authHeader, userId }) {
  if (!cfg.fivesim.apiKey) {
    throw new Error('FIVESIM_API_KEY not set in .env');
  }
  // Tunnel 5sim API calls through the same residential proxy this worker is
  // using for medal.tv. With many workers and only one shared 5sim IP,
  // 5sim's per-IP rate limiter starts 429-ing /user/buy/activation as
  // "no free phones" even when stock is available — see logs from boot
  // rushes. Pinning each verifyPhone() to its worker's proxy spreads buy
  // requests across as many upstream IPs as the proxy pool provides.
  // Falls back to direct (no proxy) when the worker isn't using a proxy.
  // 5sim does not need to share the account's IP, and the residential socks5
  // proxy blocks 5sim (TLS handshake fails / timeouts). Route it direct.
  const sms = new FiveSim({ ...cfg.fivesim, proxy: null });
  const retries = Math.max(1, cfg.fivesim.phoneRetries);
  const perOpCap = Math.max(1, cfg.fivesim.maxAttemptsPerOperator);
  // Higher cap for errorId:37 specifically — see config docstring.
  const numberBlockCap = Math.max(perOpCap, cfg.fivesim.numberBlockRetries);
  const medalRejectThreshold = Math.max(1, cfg.fivesim.medalRejectThreshold);
  const usedThisCall = new Set();

  // Count Medal-side rejections (4xx on settings POST OR silent
  // unverifiedPhone-mismatch). When this hits medalRejectThreshold without
  // any successful SMS round-trip, the Medal account itself is throttled
  // (per-user phone-update rate-limit / anti-fraud lock) — switching 5sim
  // operators won't help. We bail out with a distinct failReason so the
  // caller drops the account and a fresh Medal account is created for
  // the same Java account (Microsoft cookie). Counter resets on any
  // progress past the settings POST
  // (i.e. once Medal accepts a phone and we wait for SMS).
  let medalRejections = 0;

  // Track which operators returned errorId:37 ("Number blocked for SMS").
  // These are per-range Medal blocks — different operators = different
  // ranges, so rotating to a fresh operator is the right move. Only when
  // EVERY available operator (top-N + expanded fallback) is in this set
  // do we conclude the block is account-wide and bail with
  // medal_account_throttled.
  const numberBlockedOps = new Set();

  // Track which operators we've already worked through in this verifyPhone
  // call. Operators land here when they hit per-op cap OR return no-stock,
  // so we don't loop back to them. The ranking itself is re-queried from
  // 5sim's /guest/prices every time we need to pick the next operator,
  // which means stock that just refilled (or new operators that came online)
  // get picked up automatically — no static list to fall behind.
  const triedOps = new Set();
  // Operators that returned no-stock at buy time (we'll skip them on a
  // re-query unless even more time passes).
  const noStockOps = new Set();

  let ranking = await pickOperatorsForVerify(sms, cfg);

  let lastError = null;
  let totalAttempts = 0;

  // Outer loop: pick best untried operator from live ranking; refresh
  // ranking from /guest/prices whenever we need to advance.
  while (totalAttempts < retries) {
    let op = ranking.find((o) => !triedOps.has(o));
    if (!op) {
      // Every operator in the cached ranking has been tried in this call.
      // Force-refresh /guest/prices: stock may have refilled, or higher-rate
      // operators that were at count=0 may have stock now.
      log(`5sim: all ${triedOps.size} ranked operator(s) tried this call — re-applying ranking from cached /guest/prices`);
      ranking = await pickOperatorsForVerify(sms, cfg, { force: true });
      op = ranking.find((o) => !triedOps.has(o));
      if (!op) {
        // Standard ranking exhausted (no untried op meets minRate). Always
        // expand the pool to INCLUDE lower-rate operators we'd normally
        // filter out — at this point trying a 3% / 1% operator is strictly
        // better than giving up and burning the account. This handles BOTH
        // failure modes:
        //   • All tried ops returned errorId:37 (number-blocked at Medal):
        //     low-rate ranges are less abused → may not be Medal-blocked.
        //   • All tried ops ran out of stock / hit per-op SMS-fail cap:
        //     low-rate ops still have huge stock and *some* SMS delivery,
        //     which beats failing the verify entirely.
        log(
          `5sim: standard ranking exhausted (tried=[${[...triedOps].join(', ')}], ` +
            `no-stock=[${[...noStockOps].join(', ')}], ` +
            `number-blocked=[${[...numberBlockedOps].join(', ')}]) — ` +
            `expanding pool to include low-rate operators we'd normally skip`
        );
        ranking = await pickOperatorsForVerify(sms, cfg, {
          force: true,
          expandPool: true,
        });
        op = ranking.find((o) => !triedOps.has(o));
        if (!op) {
          // Final last-resort: try the 'any' operator. /guest/prices
          // doesn't list it, but 5sim routes 'any' orders to whichever
          // operator has stock backend-side — including ranges that
          // weren't enumerated. We only land here when EVERY named op
          // is out of stock or fully blocked, which empirically happens
          // when only `virtual58` is listed at 0% rate but 'any' still
          // has thousands of numbers waiting in unlisted partner pools.
          if (cfg.fivesim.useAnyAsLastResort && !triedOps.has('any')) {
            log(
              `5sim: every named operator exhausted ` +
                `(tried=[${[...triedOps].join(', ')}], ` +
                `no-stock=[${[...noStockOps].join(', ')}], ` +
                `number-blocked=[${[...numberBlockedOps].join(', ')}]) — ` +
                `falling back to 'any' (5sim auto-routes to in-stock pool)`
            );
            op = 'any';
          } else {
            // Truly nothing left to try. If the failure mode is "every
            // operator number-blocked", upgrade to medal_account_throttled
            // so the caller burns this account and a fresh Medal account
            // is created for the same Java account (Microsoft cookie).
            if (numberBlockedOps.size > 0 && numberBlockedOps.size === triedOps.size) {
              throw Object.assign(
                new Error(
                  `medal_account_throttled: userId=${userId} number-blocked across ` +
                    `every available operator [${[...numberBlockedOps].join(', ')}] — ` +
                    `Medal flagged this account at the user level (likely from a ` +
                    `prior geo-mismatch run); no fresh number can register`
                ),
                { failReason: 'medal_account_throttled' }
              );
            }
            log(`5sim: even expanded pool produced no untried operators — giving up`);
            break;
          }
        }
      }
    }

    let opNoStock = false;
    let opAttempt = 0;
    // Counts only NON-errorId:37 failures (SMS timeouts, code rejections).
    // The per-op cap (perOpCap=3) applies to this count.
    let opOtherFails = 0;
    let opAdvance = false; // signals "move to next operator"
    // Per-operator counter for errorId:37 ("number blocked"). Counts
    // only number-block rejections; capped separately by numberBlockCap
    // (default 6) so we burn more numbers on the same op before declaring
    // its whole range Medal-blocked.
    let opNumberBlocks = 0;

    // Inner loop runs while EITHER cap is unfilled. We check the relevant
    // cap based on which failure mode is in play after the post fails.
    while (
      opOtherFails < perOpCap &&
      opNumberBlocks < numberBlockCap &&
      totalAttempts < retries &&
      !opAdvance
    ) {
      opAttempt++;
      totalAttempts++;
      const attempt = totalAttempts;

      const bought = await buyFreshPhone({
        sms,
        operators: [op], // single operator — rotation handled by outer loop
        country: cfg.fivesim.country,
        product: cfg.fivesim.product,
        attempt,
        retries,
        usedThisCall,
      });

      if (!bought) {
        // Operator dry of fresh numbers — abandon it for this call.
        lastError = new Error(
          `5sim: operator ${op} has no fresh stock (attempt ${attempt}/${retries}) — rotating`
        );
        log(lastError.message);
        opNoStock = true;
        opAdvance = true;
        await new Promise((r) => setTimeout(r, 1500 + Math.floor(Math.random() * 1000)));
        break;
      }

      const { order, opUsed, phone } = bought;
    const orderId = order.id;
    usedThisCall.add(phone);
    // One concise line per attempt instead of two ("got phone" + "POST settings").
    // Order id and userId are kept on the same line so a grep on the phone
    // number still pulls all the context out, just shorter.
    log(`try ${phone} op=${opUsed} attempt=${attempt}/${retries} (order=${orderId} user=${userId})`);

    // ---- Step 1: submit phone to Medal ----
    // Wrapped in its own try so a 429 here (Medal phone-throttle) loops to
    // a fresh number instead of bubbling out and burning the whole account.
    let settingsRes;
    try {
      settingsRes = await client.postJson(
        `${MEDAL_API}/users/${userId}/settings`,
        { phone },
        client.medalHeaders({ 'X-Authentication': authHeader })
      );
    } catch (e) {
      const msg = String(e.message || '');
      const is429 = /->\s*429\b/.test(msg);
      const isPhoneThrottled =
        is429 ||
        /errorId"?\s*:\s*402\b/.test(msg) ||
        /perform this action this frequently/i.test(msg) ||
        /->\s*4\d\d\b/.test(msg);

      // Medal errorId:37 = "This number has been blocked for sms" /
      // "Number temporarily blocked". This is range-specific, NOT
      // account-specific: every number from the same 5sim operator
      // shares one number range, so all numbers from that operator
      // will return errorId:37. Different operators = different ranges
      // = potentially unblocked. Rotating immediately is much more
      // efficient than burning 2 more attempts on the same dead range.
      const isNumberRangeBlocked =
        /errorId"?\s*:\s*37\b/.test(msg) ||
        /Number\s+temporarily\s+blocked/i.test(msg) ||
        /blocked\s+for\s+sms/i.test(msg);

      // Pull out the status code + response body preview from the
      // postJson error so the log line tells us *why* Medal rejected the
      // phone (e.g. invalid_number, country_mismatch, throttled). Without
      // this all we'd see is a generic "(rejected)".
      const statusMatch = msg.match(/->\s*(\d{3})\b/);
      const httpStatus = statusMatch ? statusMatch[1] : '???';
      const bodyMatch = msg.match(/->\s*\d{3}:\s*([\s\S]*)$/);
      const respBody = bodyMatch ? bodyMatch[1].slice(0, 300) : msg.slice(0, 300);

      if (isNumberRangeBlocked && attempt < retries) {
        // Medal blocked this specific NUMBER. The block CAN be range-wide
        // (whole 5sim operator pool flagged) but it's not always: 5sim
        // sometimes hands out individual numbers that were already used
        // by some other Medal user, while other numbers from the same
        // operator are still pristine. Retry on the same operator with
        // fresh numbers up to numberBlockCap (default 6) times before
        // concluding the whole range is blocked and rotating to a
        // different op.
        opNumberBlocks += 1;
        const willRotate = opNumberBlocks >= numberBlockCap || attempt + 1 > retries;
        // Skip the full HTTP body here — errorId:37 always means the same
        // thing ("Number temporarily blocked") and the body just adds ~200
        // chars of pure noise to every line. The status code is also
        // implicit in "number-blocked", so we drop it too. Status/body still
        // get logged for unexpected throttles below, where they carry signal.
        log(
          `number-blocked ${phone} op=${op} ` +
            `(${opNumberBlocks}/${numberBlockCap}` +
            `${willRotate ? ', rotating op' : ', retrying'})`
        );
        markPhoneBurned(phone);
        await safe(() => sms.banOrder(orderId), 'ban-on-number-blocked');
        lastError = e;
        // Don't bump medalRejections — this is a per-number issue, not a
        // per-account issue. The account-throttle check below is for
        // genuine account-level locks (silent drops, repeated 4xx that
        // aren't errorId:37), where rotating operators can't help.
        if (opNumberBlocks >= numberBlockCap) {
          // Every attempt on this op got number-blocked → treat the WHOLE
          // operator's number range as Medal-blocked. Mark it so the outer
          // loop's "all ops blocked → medal_account_throttled" escalation
          // can still fire when this happens across every operator.
          numberBlockedOps.add(op);
          opAdvance = true;
        }
        // Otherwise: fall through to next inner-loop iteration → fresh
        // number from the SAME operator → retry.
        continue;
      }

      if (isPhoneThrottled && attempt < retries) {
        log(
          `medal rejected phone ${phone} on settings POST — ` +
            `HTTP ${httpStatus}: ${respBody}  (burning + retrying with fresh number)`
        );
        markPhoneBurned(phone);
        await safe(() => sms.banOrder(orderId), 'ban-on-medal-throttle');
        lastError = e;
        opOtherFails += 1;
        medalRejections += 1;
        // Per-account Medal lock: we've now had medalRejectThreshold
        // back-to-back Medal rejections regardless of which 5sim operator
        // we used → no point burning more numbers, the ACCOUNT is throttled.
        if (medalRejections >= medalRejectThreshold) {
          throw Object.assign(
            new Error(
              `medal_account_throttled: userId=${userId} silently rejected ${medalRejections} ` +
                `consecutive phone updates (last=${phone}) across ` +
                `operators=[${[op, ...triedOps].filter((v, i, a) => a.indexOf(v) === i).join(', ')}]`
            ),
            { failReason: 'medal_account_throttled' }
          );
        }
        // Longer cool-down on 429 so we don't pile back into the same throttle window.
        if (is429) {
          await new Promise((r) => setTimeout(r, 4000 + Math.floor(Math.random() * 4000)));
        }
        continue; // next attempt with a fresh phone
      }

      log(`medal phone-submit failed (non-retriable): ${msg}`);
      await safe(() => sms.cancelOrder(orderId), 'cancel-on-error');
      throw e;
    }

    // Medal's response should echo the phone we just submitted as
    // unverifiedPhone. If the field is still set to a *previous* number (or
    // empty), Medal silently rejected our update — typically because the
    // user-level anti-fraud throttle kicked in. Catch that here so we don't
    // waste 90 s waiting for an SMS Medal never triggered.
    const unverified = settingsRes?.unverifiedPhone;
    log(`medal: settings ok unverifiedPhone=${unverified ?? 'null'} phone=${settingsRes?.phone ?? 'null'}`);

    const normSubmitted = String(phone).replace(/[^\d+]/g, '');
    const normUnverified = String(unverified || '').replace(/[^\d+]/g, '');
    if (!unverified || normUnverified !== normSubmitted) {
      log(
        `medal: settings response did NOT register ${phone} ` +
          `(server still shows unverifiedPhone=${unverified ?? 'null'}). ` +
          `Treating as silent rate-limit — banning + cooling down before next attempt.`
      );
      markPhoneBurned(phone);
      await safe(() => sms.banOrder(orderId), 'ban-on-stale-unverified');
      lastError = new Error(
        `medal silently kept old unverifiedPhone=${unverified ?? 'null'} after submitting ${phone}`
      );
      opOtherFails += 1;
      medalRejections += 1;
      if (medalRejections >= medalRejectThreshold) {
        throw Object.assign(
          new Error(
            `medal_account_throttled: userId=${userId} silently dropped ${medalRejections} ` +
              `consecutive phone updates (last submitted=${phone}, server still ` +
              `shows unverifiedPhone=${unverified ?? 'null'})`
          ),
          { failReason: 'medal_account_throttled' }
        );
      }
      // Long cool-down so Medal's per-user phone-update throttle can reset.
      await new Promise((r) => setTimeout(r, 8000 + Math.floor(Math.random() * 4000)));
      continue;
    }

    // Medal ACCEPTED the phone (unverifiedPhone now matches what we sent).
    // Reset the consecutive-rejections counter — past failures were the
    // numbers themselves, not the account. Subsequent SMS-timeout / code-
    // rejected branches don't bump this counter (those are 5sim/phone
    // problems, not Medal-account problems).
    medalRejections = 0;

    // ---- Step 2: wait for SMS ----
    vlog(
      `5sim: waiting up to ${Math.round(cfg.fivesim.waitMs / 1000)}s for SMS ` +
        `(poll every ${Math.round(cfg.fivesim.pollMs / 1000)}s)...`
    );
    const start = Date.now();
    let code, smsMsg;
    try {
      const res = await sms.waitForCode(orderId, {
        timeoutMs: cfg.fivesim.waitMs,
        intervalMs: cfg.fivesim.pollMs,
        onPoll: ({ status, smsCount, error }) => {
          const dt = Math.round((Date.now() - start) / 1000);
          if (error) vlog(`5sim poll[${dt}s] error=${error}`);
          else vlog(`5sim poll[${dt}s] status=${status} sms=${smsCount}`);
        },
      });
      code = res.code;
      smsMsg = res.sms;
    } catch (e) {
      log(`5sim: no SMS on ${phone} (${e.message}). Cancelling order and trying a new number.`);
      // Mark burned so other concurrent workers skip it too.
      markPhoneBurned(phone);
      await safe(() => sms.cancelOrder(orderId), 'cancel-on-timeout');
      lastError = e;
      opOtherFails += 1;
      // Brief cool-down so back-to-back phone updates don't trip Medal's
      // per-user phone-update rate limit (which goes silent after a few
      // updates and only surfaces as 429 around attempt 6-7).
      await new Promise((r) => setTimeout(r, 2500 + Math.floor(Math.random() * 2000)));
      continue; // next attempt
    }

    vlog(
      `5sim: SMS arrived from "${smsMsg.sender || '?'}": "${smsMsg.text}" -> code=${code}`
    );

    // ---- Step 3: submit code ----
    let verifyResult;
    try {
      verifyResult = await submitPhoneCode({ cfg, client, authHeader, userId, code });
      log(`phone ${phone} verified  code=${code}`);
    } catch (e) {
      const msg = String(e.message || '');
      const isBurnedNumber =
        /Phone\s+verification\s+failed/i.test(msg) ||
        /errorId"?\s*:\s*26\b/.test(msg) ||
        /errorId"?\s*:\s*402\b/.test(msg) ||
        /->\s*4\d\d\b/.test(msg);

      if (isBurnedNumber && attempt < retries) {
        log(
          `medal rejected SMS code on ${phone} — likely a recycled/burned number. ` +
            `Banning on 5sim and trying a fresh number. (${msg.slice(0, 120)})`
        );
        markPhoneBurned(phone);
        await safe(() => sms.banOrder(orderId), 'ban-burned-number');
        lastError = e;
        opOtherFails += 1;
        continue; // next attempt
      }

      log(`medal code submit failed: ${msg}`);
      await safe(() => sms.cancelOrder(orderId), 'cancel');
      throw e;
    }

    await safe(() => sms.finishOrder(orderId), 'finish');

      return {
        phone,
        phoneOrderId: orderId,
        phoneCode: code,
        phoneVerifyAttempts: attempt,
        phoneVerifiedAt: new Date().toISOString(),
        phoneVerifyResponse: stripBigFields(verifyResult),
      };
    }

    // ---- Inner loop ended without success ----
    // Either we hit per-op cap (perOpCap fresh numbers from this op all
    // failed Medal verification) or `opAdvance` was set (no-stock at buy
    // time). Either way, retire this operator for the rest of the call
    // and force a fresh /guest/prices ranking — stock may have refilled,
    // and another operator might now be the best pick.
    triedOps.add(op);
    if (opNoStock) noStockOps.add(op);
    if (totalAttempts < retries) {
      ranking = await pickOperatorsForVerify(sms, cfg, { force: true });
    }
  }

  throw Object.assign(
    new Error(
      `phone verification failed after ${totalAttempts} attempts ` +
        `(per-op cap ${perOpCap}/numberBlock cap ${numberBlockCap}, tried=[${[...triedOps].join(', ')}]` +
        `${noStockOps.size > 0 ? `, no-stock=[${[...noStockOps].join(', ')}]` : ''}): ` +
        `${lastError?.message || 'no SMS received'}`
    ),
    { failReason: 'phone_exhausted' }
  );
}

/**
 * Submits the SMS code Medal expects. The exact endpoint/body shape is
 * captured from the Electron client after the user types the code into the
 * "Verify phone" modal. If you haven't captured it yet, set these in .env:
 *
 *   MEDAL_PHONE_VERIFY_ENDPOINT=/api/users/{userId}/settings
 *   MEDAL_PHONE_VERIFY_FIELD=phoneVerificationCode
 *
 * Once you've captured the real request, update those two values.
 */
async function submitPhoneCode({ cfg, client, authHeader, userId, code }) {
  const endpoint = cfg.phoneVerifyEndpoint.replace('{userId}', userId);
  const url = endpoint.startsWith('http')
    ? endpoint
    : `https://medal.tv${endpoint}`;
  const body = { [cfg.phoneVerifyBodyField]: code };
  vlog(`POST ${url}  body=${JSON.stringify(body)}`);
  return client.postJson(
    url,
    body,
    client.medalHeaders({ 'X-Authentication': authHeader })
  );
}

/**
 * Uploads a pre-recorded MP4 clip to Medal.tv and posts it to the user's profile.
 *
 * Full flow (reverse-engineered from Medal-Electron's main.min.js):
 *   1. POST api-v2.medal.tv/users/:uid/content            → draft, returns contentId
 *   2. POST api-v2.medal.tv/uploads/content?contentId=<id>
 *          body: { contentLength, contentType:"video/mp4", resumable:true }
 *          → { signedUrl, taskId, temporaryAssetUrl }
 *   3. POST <signedUrl>  x-goog-resumable:start           → GCS session URI (Location)
 *   4. PUT  <sessionUri> with full file bytes             → 200
 *   5. POST api-v2.medal.tv/tasks/<taskId>/checksum
 *          body: { crc32c: <base64 of BE uint32 CRC32C> } → triggers transcoding
 *   6. (poll) GET api-v2.medal.tv/content/<id> until isShareable=true
 *   7. POST api-v2.medal.tv/content/<id>                  → set title/tags/privacy=PUBLIC
 *                                                           → posts to profile
 */
async function uploadClip({ cfg, userId, authKey, clipPath: cliClipPath, log: _log, contentType = CONTENT_TYPE_UPLOAD, proxy = null }) {
  // _log is currently the same shared `log()` passed in from createAccount,
  // but treat the verbose channel through vlog() regardless of caller so we
  // can still mute the chatty per-step output.
  const log = _log || ((m) => console.log(`[${new Date().toISOString()}] ${m}`));
  const clipCfg = cfg.clip;

  const mp4Path = cliClipPath || clipCfg.path;
  if (!mp4Path) throw new Error('No clip path configured (MEDAL_CLIP_PATH or --clip-path)');
  if (!fs.existsSync(mp4Path)) throw new Error(`Clip file not found: ${mp4Path}`);

  const fileSize = fs.statSync(mp4Path).size;

  // Headers matching Medal-Electron's internal defaultHeaders() exactly
  const h = () => ({
    accept: 'application/json',
    'content-type': 'application/json',
    'user-agent': MEDAL_UA,
    'x-authentication': `${userId},${authKey}`,
  });
  // Route Medal API calls through the same upstream proxy as the account so the
  // clip is created/posted from a consistent IP. The GCS byte upload stays
  // direct (Google storage, not Medal's anti-fraud surface).
  const _agent = proxyAgent(proxy);
  const ax = _agent ? { httpAgent: _agent, httpsAgent: _agent, proxy: false } : {};

  // --- Step 1: Create content draft ---
  vlog(`clip: creating draft (size=${fileSize} duration=${clipCfg.duration}s category=${clipCfg.categoryId})`);
  const isClip = contentType === CONTENT_TYPE_CLIP;
  const draftBody = {
    categoryId: clipCfg.categoryId,
    contentType,
    ...(isClip
      ? {
          videoLengthSeconds: clipCfg.duration,
          contentTitle: clipCfg.title,
          contentDescription: clipCfg.description,
          clientId: uuidv4(),
          tags: clipCfg.tags,
          metadata: { triggerType: 'hotkey' },
        }
      : {
          size: fileSize,
          duration: clipCfg.duration,
        }),
  };
  const r1 = await axios.post(
    `${MEDAL_V2_API}/users/${userId}/content`,
    draftBody,
    { headers: h(), validateStatus: () => true, ...ax }
  );
  if (r1.status !== 200) {
    throw new Error(`create draft failed ${r1.status}: ${JSON.stringify(r1.data)}`);
  }
  const contentId = r1.data.contentId;
  vlog(`clip: draft created contentId=${contentId}`);

  // --- Step 2: Get GCS resumable signed URL ---
  vlog('clip: requesting GCS signed upload URL...');
  const r2 = await axios.post(
    `${MEDAL_V2_API}/uploads/content?contentId=${contentId}`,
    { contentLength: fileSize, contentType: 'video/mp4', resumable: true },
    { headers: h(), validateStatus: () => true, ...ax }
  );
  if (r2.status !== 200) {
    throw new Error(`get upload URL failed ${r2.status}: ${JSON.stringify(r2.data)}`);
  }
  const { signedUrl, taskId, temporaryAssetUrl } = r2.data;
  vlog(`clip: got signedUrl taskId=${taskId}`);

  // --- Step 3: Initiate GCS resumable session ---
  vlog('clip: initiating GCS resumable session...');
  const r3 = await axios.post(signedUrl, null, {
    validateStatus: () => true,
    maxRedirects: 0,
    headers: {
      'content-type': 'video/mp4',
      'content-length': '0',
      'x-goog-resumable': 'start',
      'x-upload-content-type': 'video/mp4',
      'x-upload-content-length': String(fileSize),
    },
  });
  const sessionUri = r3.headers.location;
  if (!sessionUri) {
    throw new Error(`GCS session init failed ${r3.status}: ${JSON.stringify(r3.data)}`);
  }
  vlog('clip: GCS session URI obtained');

  // --- Step 4: Upload file bytes ---
  vlog(`clip: uploading ${Math.round(fileSize / 1024 / 1024)}MB to GCS...`);
  const fileStream = fs.createReadStream(mp4Path);
  const r4 = await axios.put(sessionUri, fileStream, {
    validateStatus: () => true,
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': fileSize,
      'Content-Range': `bytes 0-${fileSize - 1}/${fileSize}`,
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
  if (r4.status < 200 || r4.status >= 300) {
    throw new Error(`GCS upload failed ${r4.status}: ${String(r4.data).slice(0, 200)}`);
  }
  vlog('clip: upload complete (GCS 200)');

  // --- Step 5: Submit CRC32C checksum to trigger transcoding ---
  // Medal's GcsUploadHandler requires the base64-encoded big-endian CRC32C of
  // the uploaded bytes. Without this call the clip stays in "draft" forever.
  vlog('clip: computing CRC32C checksum...');
  const fileBuf = fs.readFileSync(mp4Path);
  const crcInt = crc32c.calculate(fileBuf);
  const crcBE = Buffer.alloc(4);
  crcBE.writeUInt32BE(crcInt, 0);
  const crcB64 = crcBE.toString('base64');

  vlog(`clip: submitting checksum crc32c=${crcB64} -> /tasks/${taskId}/checksum`);
  const r5 = await axios.post(
    `${MEDAL_V2_API}/tasks/${taskId}/checksum`,
    { crc32c: crcB64 },
    { headers: h(), validateStatus: () => true, ...ax }
  );
  if (r5.status !== 200) {
    throw new Error(`checksum submit failed ${r5.status}: ${JSON.stringify(r5.data)}`);
  }
  vlog(`clip: checksum accepted, task state=${r5.data?.state || 'unknown'} (transcoding started)`);

  // --- Step 6: Poll until clip is shareable ---
  const pollMs = clipCfg.pollMs;
  const timeoutMs = clipCfg.timeoutMs;
  const started = Date.now();
  let clipState = null;
  while (Date.now() - started < timeoutMs) {
    const g = await axios.get(
      `${MEDAL_V2_API}/content/${contentId}`,
      { headers: h(), validateStatus: () => true, ...ax }
    );
    if (g.status === 200) {
      clipState = g.data;
      const t = Math.round((Date.now() - started) / 1000);
      vlog(`clip: poll[${t}s] state=${clipState.state?.type} shareable=${clipState.state?.isShareable} processed=${clipState.processed}`);
      if (clipState.state?.isShareable || clipState.publishedAt) break;
    }
    await new Promise((res) => setTimeout(res, pollMs));
  }
  if (!clipState?.state?.isShareable && !clipState?.publishedAt) {
    log('clip: WARNING timed out waiting for shareable state; attempting publish anyway');
  }

  // --- Step 7: Post to profile (set privacy=PUBLIC + title/tags) ---
  vlog(`clip: posting to profile privacy=${clipCfg.privacy === PRIVACY_PUBLIC ? 'PUBLIC' : clipCfg.privacy} title="${clipCfg.title}"`);
  const r7 = await axios.post(
    `${MEDAL_V2_API}/content/${contentId}`,
    {
      contentTitle: clipCfg.title,
      contentDescription: clipCfg.description,
      tags: clipCfg.tags,
      privacy: clipCfg.privacy,
    },
    { headers: h(), validateStatus: () => true, ...ax }
  );
  if (r7.status !== 200) {
    throw new Error(`publish failed ${r7.status}: ${JSON.stringify(r7.data)}`);
  }
  const shareUrl = r7.data.contentShareUrl || `https://medal.tv/games/minecraft/clips/${contentId}`;
  const finalState = r7.data.state?.type || 'unknown';
  log(`clip: published ${shareUrl}`);
  vlog(`clip: state=${finalState} privacy=${r7.data.privacy}`);

  return {
    contentId,
    taskId,
    temporaryAssetUrl,
    shareUrl,
    crc32c: crcB64,
    state: finalState,
    isShareable: r7.data.state?.isShareable === true,
    publishedAt: r7.data.publishedAt,
  };
}

async function safe(fn, label) {
  try {
    await fn();
  } catch (e) {
    vlog(`5sim ${label} failed (non-fatal): ${e.message}`);
  }
}

function stripBigFields(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const { achievements, premiumSettings, platformsInstalled, ...rest } = obj;
  return rest;
}

function appendAccount(filePath, record) {
  fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
}

/**
 * Replace the stored record for `userId` with `updatedRecord` (matching the
 * line by userId), appending if it is not present. Used by the java flow to
 * finalize an account that was persisted right after phone verification —
 * before the Microsoft-link step — so a crash or frozen link window can never
 * lose a paid, phone-verified account.
 */
function updateAccountEntry(filePath, userId, updatedRecord) {
  if (!fs.existsSync(filePath)) {
    fs.appendFileSync(filePath, JSON.stringify(updatedRecord) + '\n', 'utf8');
    return true;
  }
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  const target = String(userId);
  let replaced = false;
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (!replaced && String(r.userId) === target) {
        out.push(JSON.stringify(updatedRecord));
        replaced = true;
        continue;
      }
    } catch {
      /* keep unparseable lines verbatim */
    }
    out.push(line);
  }
  if (!replaced) out.push(JSON.stringify(updatedRecord));
  fs.writeFileSync(filePath, out.join('\n') + '\n', 'utf8');
  return replaced;
}

/**
 * Writes a failed-attempt entry to failed-accounts.jsonl.
 * Includes the partial account details plus the failure reason, so a partial
 * run can be retried manually without losing what already happened.
 */
function appendFailedAccount(filePath, partialRecord, failReason, args) {
  const entry = {
    ...partialRecord,
    failReason,
    failedAt: new Date().toISOString(),
    // Preserve the intended quest target so the run can be retried manually
    ...(args.questId ? { intendedQuestId: args.questId } : {}),
  };
  try {
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf8');
    vlog(`failed account logged to ${path.basename(filePath)} (reason: ${failReason})`);
  } catch (writeErr) {
    log(`WARNING: could not write to ${filePath}: ${writeErr.message}`);
  }
}

// Single-flight write chain so concurrent workers can't interleave their
// rewrites of failed-accounts.jsonl and corrupt it.
let _failedAccountsWriteChain = Promise.resolve();
function withFailedAccountsLock(fn) {
  const next = _failedAccountsWriteChain.then(() => fn(), () => fn());
  _failedAccountsWriteChain = next.catch(() => {});
  return next;
}

async function removeFromFailedAccounts(filePath, userId) {
  return withFailedAccountsLock(async () => {
    if (!fs.existsSync(filePath)) return false;
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    const target = String(userId);
    let removed = false;
    const kept = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (String(r.userId) === target) { removed = true; continue; }
      } catch { /* preserve bad lines verbatim */ }
      kept.push(line);
    }
    fs.writeFileSync(filePath, kept.length ? kept.join('\n') + '\n' : '', 'utf8');
    return removed;
  });
}

async function updateFailedAccountEntry(filePath, userId, updates) {
  return withFailedAccountsLock(async () => {
    if (!fs.existsSync(filePath)) return false;
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    const target = String(userId);
    let hit = false;
    const out = lines.map((line) => {
      if (!line.trim()) return line;
      try {
        const r = JSON.parse(line);
        if (String(r.userId) === target) {
          hit = true;
          return JSON.stringify({ ...r, ...updates });
        }
      } catch { /* skip malformed */ }
      return line;
    });
    fs.writeFileSync(filePath, out.join('\n'), 'utf8');
    return hit;
  });
}

function maskProxy(p) {
  return p.replace(/\/\/([^:@]+):([^@]+)@/, '//$1:***@');
}

// --------------------------------------------------------------------------
// Java-cookie flow (one Medal account per Microsoft/Minecraft cookie export)
// --------------------------------------------------------------------------
// The operator connects their own Minecraft Java account: they export the
// signed-in Microsoft session cookie (Netscape format .txt) and drop it into
// JAVA_COOKIE_DIR (or pass --java-cookie <file-or-dir>). For each cookie the
// bot mints ONE Medal account: signup -> phone verify -> clip upload/post,
// then records the cookie against the account and STOPS. The quest reward is
// never claimed here — the operator redeems it in-game as the Java account.

function listJavaCookieFiles(cfg, cliPath) {
  const targets = [];
  const push = (f) => {
    if (/\.(txt|json|bak)$/i.test(f)) targets.push(f);
  };
  if (cliPath) {
    const abs = path.resolve(cliPath);
    if (!fs.existsSync(abs)) {
      throw new Error(`--java-cookie path not found: ${abs}`);
    }
    if (fs.statSync(abs).isDirectory()) {
      for (const f of fs.readdirSync(abs).sort()) push(path.join(abs, f));
    } else {
      push(abs);
    }
  } else {
    if (!fs.existsSync(cfg.javaCookieDir)) {
      throw new Error(
        `java cookie dir not found: ${cfg.javaCookieDir} ` +
          '(drop Netscape .txt cookie exports there, or pass --java-cookie <file-or-dir>)'
      );
    }
    for (const f of fs.readdirSync(cfg.javaCookieDir).sort()) {
      push(path.join(cfg.javaCookieDir, f));
    }
  }
  return targets;
}

function javaCookieFilesDone(cfg) {
  // Cookie stems that already produced a Medal account (mode=java) in an
  // earlier run, so re-runs don't mint a second account for the same cookie.
  const done = new Set();
  for (const rec of loadAccountsFile(cfg.accountsFile)) {
    if (rec && rec.mode === 'java' && rec.javaCookieFile) {
      done.add(rec.javaCookieFile);
    }
  }
  return done;
}

// Cookie files that already failed the Microsoft link (bad/expired session,
// identity already bound to another Medal account) are remembered so a re-run
// skips them instead of spending a fresh 5sim number on the same dead cookie.
function loadBadJavaCookies(cfg) {
  const bad = new Set();
  const dir = cfg.badJavaCookiesDir;
  if (!dir || !fs.existsSync(dir)) return bad;
  for (const f of fs.readdirSync(dir)) {
    if (/\.(txt|json|bak)$/i.test(f)) bad.add(f);
  }
  return bad;
}

function recordBadJavaCookie(cfg, fileName, reason) {
  try {
    fs.mkdirSync(cfg.badJavaCookiesDir, { recursive: true });
    const src = path.join(cfg.javaCookieDir, fileName);
    const dst = path.join(cfg.badJavaCookiesDir, fileName);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      fs.renameSync(src, dst);
    }
    if (reason) {
      try {
        fs.writeFileSync(`${dst}.reason.txt`, `${reason}\n${new Date().toISOString()}\n`, 'utf8');
      } catch (_) { /* best-effort */ }
    }
  } catch (e) {
    log(`WARNING: could not move bad cookie ${fileName}: ${e.message}`);
  }
}

// --------------------------------------------------------------------------
// Microsoft ("Connect Minecraft") account link
// --------------------------------------------------------------------------
// Medal's social providers page links a Microsoft/Minecraft identity by:
//   1. POST /api/connections  {provider:"microsoft"}  -> {callbackId, loginUrl}
//   2. driving the browser through loginUrl (login.live.com OAuth, scopes
//      Xboxlive.signin + offline_access) until it lands back on Medal's
//      redirect_uri (https://social-api.medal.tv/connections/callback), which
//      is the server-side code exchange.
//   3. polling GET /api/connections/{callbackId} (skipAuth) for the final
//      status.
// The exported Netscape cookie file is what makes step 2 sign into Microsoft
// without the operator typing anything. If the session is dead, Microsoft
// shows a sign-in form instead of redirecting; if the identity is already
// bound to another Medal account, the callback reports an error. Both are
// surfaced here as { linked:false, reason } so the java flow drops that cookie
// and moves on to the next one.

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Close a playwright browser, but never let a stalled close (a page stuck in an
// endless Microsoft navigation) hang the flow. If graceful close doesn't finish
// in a few seconds, hard-kill the browser's child process instead.
async function closeBrowserQuiet(browser) {
  if (!browser) return;
  const proc = browser.process && browser.process();
  try {
    await Promise.race([browser.close(), sleepMs(4000)]);
  } catch (_) {
    /* ignore */
  }
  if (proc && proc.exitCode === null && proc.kill) {
    try {
      proc.kill();
    } catch (_) {
      /* already gone */
    }
  }
}

// Convert the bot's proxy URL (http://user:pass@host:port, socks5://…) into
// playwright's {server, username, password} shape, or undefined when absent.
function toPlaywrightProxy(proxyUrl) {
  if (!proxyUrl) return undefined;
  let s = String(proxyUrl).trim();
  let scheme = 'http';
  const sc = s.match(/^([a-z0-9]+):\/\//i);
  if (sc) {
    scheme = sc[1];
    s = s.slice(sc[0].length);
  }
  const at = s.lastIndexOf('@');
  let hostport = s;
  const cfg = {};
  if (at !== -1) {
    const creds = s.slice(0, at).split(':');
    cfg.username = decodeURIComponent(creds[0]);
    cfg.password = decodeURIComponent(creds.slice(1).join(':'));
    hostport = s.slice(at + 1);
  }
  hostport = hostport.split(/[?#]/)[0]; // drop any session query
  cfg.server = `${scheme}://${hostport}`;
  return cfg;
}

// Only Microsoft auth-bearing hosts matter for the OAuth handshake. The export
// is often littered with unrelated tracking cookies we must NOT replay.
const MS_AUTH_DOMAIN_SUFFIXES = [
  'login.live.com',
  'live.com',
  'microsoftonline.com',
  'login.microsoftonline.com',
  'account.microsoft.com',
  'microsoft.com',
  'msn.com',
  'msauth.net',
  'msftauth.net',
  'msidentity.com',
  'office.com',
  'microsoftalumni.com',
];

function cookieFileToPlaywrightCookies(cookieFile) {
  const rows = parseNetscapeCookieFile(cookieFile);
  const out = [];
  for (const r of rows) {
    const host = String(r.domain).replace(/^\./, '').toLowerCase();
    if (!MS_AUTH_DOMAIN_SUFFIXES.some((s) => host === s || host.endsWith('.' + s))) {
      continue;
    }
    const isAuthArtifact =
      r.name === '__Host-MSAAUTHP' || r.name === 'MSAAUTHP' || r.name === 'MSPAuth';
    out.push({
      name: r.name,
      value: r.value,
      // Playwright/CDP rejects a leading dot on the domain — a bare host is
      // treated as a domain cookie that also matches subdomains.
      domain: host,
      path: r.path || '/',
      secure: !!r.secure,
      httpOnly: isAuthArtifact,
      sameSite: r.secure ? 'None' : 'Lax',
      ...(r.expires > 0 ? { expires: r.expires } : {}), // 0 = session cookie
    });
  }
  return out;
}

// Poll GET /connections/{callbackId} until Medal reports a terminal status.
// Returns { status, data } or null when the deadline passes with no verdict.
async function pollConnectionCallback(medalClient, callbackId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await medalClient.http.get(
        `${MEDAL_API}/connections/${callbackId}`,
        { headers: medalClient.medalHeaders({}), validateStatus: () => true }
      );
      if (r.status === 200 && r.data && (r.data.status === 'success' || r.data.status === 'error')) {
        return { status: r.data.status, data: r.data };
      }
      // 404 = callback not processed yet (this is the "still pending" signal)
    } catch (_) {
      /* transient network error -> keep polling */
    }
    await sleepMs(2000);
  }
  return null;
}

// Drive the headful OAuth window until it reaches Medal's callback origin, or
// until a consent/sign-in page needs the operator, or the deadline passes.
// Returns true once the URL host is social-api.medal.tv (server got the code).
async function driveMsaOauth(page, timeoutMs, logFn) {
  const deadline = Date.now() + timeoutMs;
  const REDIRECT_HOST = 'social-api.medal.tv';
  let autoClicked = false;
  let manualPrompted = false;

  const consentSelectors = [
    'input[type="submit"][value="Yes"]',
    'input[type="submit"][value="yes"]',
    '#idBtn_Accept',
    'input[value="Accept"]',
    '#ConsentForm input[type="submit"]',
  ];

  while (Date.now() < deadline) {
    let url = '';
    try {
      url = page.url();
    } catch (_) {
      break; // window closed
    }
    let host = '';
    let path = '';
    let query = '';
    try {
      const u = new URL(url);
      host = u.host;
      path = u.pathname;
      query = u.search;
    } catch (_) {
      /* about:blank etc */
    }

    if (host === REDIRECT_HOST) return { ok: true };

    // Terminal Medal auth redirect: the browser lands on
    // https://medal.tv/auth?status=success|error&errorCode=..&message=..
    // once Medal has processed the OAuth code. Catch it here so a rejection
    // (e.g. errorCode 63 = already connected to another Medal account) is
    // detected immediately instead of burning the full timeout.
    if (host === 'medal.tv' || host.endsWith('.medal.tv')) {
      if (path === '/auth') {
        const q = new URLSearchParams(query);
        const status = q.get('status');
        if (status === 'success') return { ok: true };
        if (status === 'error') {
          return {
            ok: false,
            error: true,
            errorCode: q.get('errorCode'),
            message: q.get('message'),
          };
        }
      }
    }

    const onLoginLive =
      host === 'login.live.com' || host.endsWith('.login.live.com') || host.endsWith('.live.com');

    if (onLoginLive) {
      const looksInteractive =
        /(consent|authorize|approve|sessions|kmsi|login\.aspx?|oauth20)/i.test(url) &&
        !/(error=user_cancelled|error=access_denied)/i.test(url);

      if (looksInteractive && !autoClicked) {
        autoClicked = true;
        let clicked = false;
        try {
          // Give the consent form a beat to render, then try known approve/continue buttons.
          await sleepMs(1500);
          for (const sel of consentSelectors) {
            const el = page.locator(sel).first();
            if (await el.count()) {
              await el.click({ timeout: 3000 });
              clicked = true;
              break;
            }
          }
        } catch (_) {
          /* selector race — manual prompt below covers it */
        }
        if (!clicked) {
          logFn(
            `\n>>> MS LINK — approve the sign-in in the Chromium window that is open.\n` +
              `    If it shows a password / "pick an account" form, the exported cookie\n` +
              `    session was not accepted — sign in manually if you want this cookie to\n` +
              `    link, otherwise it will be marked failed. The window closes itself.\n`
          );
          manualPrompted = true;
        }
      } else if (!manualPrompted && autoClicked && looksInteractive) {
        // Auto-click didn't navigate away — surface the manual prompt now.
        manualPrompted = true;
        logFn(
          `\n>>> MS LINK — still on Microsoft's page. Approve / sign in in the window if asked;\n` +
            `    otherwise this cookie will be marked failed shortly.\n`
        );
      }
    }
    await sleepMs(400);
  }

  // Timed out before reaching Medal's callback — report where the window was
  // stuck so the operator can tell whether the cookie was refused, hit an MFA
  // / "approve sign-in" prompt, or errored instead of a silent "freeze".
  let stuckUrl = '';
  let stuckTitle = '';
  try {
    stuckUrl = page.url();
    stuckTitle = await page.title().catch(() => '');
  } catch (_) {
    /* window already closed */
  }
  return { ok: false, url: stuckUrl, title: stuckTitle };
}

/**
 * Link a fresh Medal account (userId + authKey) to the Microsoft/Minecraft
 * identity whose session is exported in `cookieFile` (Netscape .txt).
 * Never throws on a failed link — returns { linked:true } or
 * { linked:false, reason }.
 */
async function linkMinecraftAccountWithMsa({ cfg, proxy, authHeader, userId, cookieFile }) {
  const medalClient = new MedalClient({ proxy, timezone: cfg.timezone });

  // 1. Ask Medal to open a "microsoft" connection for this user.
  let begin;
  try {
    begin = await medalClient.postJson(
      `${MEDAL_API}/connections`,
      { provider: 'microsoft' },
      medalClient.medalHeaders({ 'X-Authentication': authHeader })
    );
  } catch (e) {
    return { linked: false, reason: `begin_connection_failed: ${e.message}` };
  }
  const { callbackId, loginUrl } = begin || {};
  if (!callbackId || !loginUrl || !/^https:\/\//.test(loginUrl)) {
    return { linked: false, reason: `bad_begin_response: ${JSON.stringify(begin)}` };
  }
  vlog(`[link] userId=${userId} callbackId=${callbackId}`);

  // 2. Replay the Microsoft OAuth in a headful Chromium seeded with the
  //    exported session cookies.
  let browser = null;
  let reachedCallback = false;
  try {
    const playwright = require('playwright');
    const launchOpts = { headless: true };
    if (cfg.javaLinkProxyMode === 'proxy' && proxy) {
      const pxy = toPlaywrightProxy(proxy);
      if (pxy) launchOpts.proxy = pxy;
    }
    browser = await playwright.chromium.launch(launchOpts);
    const context = await browser.newContext({
      viewport: { width: 980, height: 720 },
      locale: 'en-US',
    });
    let seeded = 0;
    try {
      const cookies = cookieFileToPlaywrightCookies(cookieFile);
      seeded = cookies.length;
      if (seeded) await context.addCookies(cookies);
    } catch (e) {
      log(`  [link] cookie seeding error: ${e.message}`);
    }
    if (seeded === 0) {
      log('  [link] no Microsoft auth cookies in export (nothing to replay)');
      return { linked: false, reason: 'no_ms_cookies' };
    }
    vlog(`[link] seeded ${seeded} Microsoft cookie(s); opening ${loginUrl}`);
    const page = await context.newPage();
    page.on('pageerror', (err) => vlog(`  [link] page error: ${err.message}`));
    await page
      .goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
      .catch(() => {});
    const drv = await driveMsaOauth(page, cfg.javaLinkTimeoutMs, log);
    reachedCallback = drv.ok;
    if (drv.error) {
      // Medal rejected the link with a concrete reason (errorCode 63 etc.).
      const msg = drv.message || `errorCode ${drv.errorCode || 'unknown'}`;
      log(`  [link] Medal rejected the link: ${msg}`);
      return { linked: false, reason: msg };
    }
    if (!drv.ok) {
      const where = drv.url
        ? `${drv.url}${drv.title ? `  ("${drv.title}")` : ''}`
        : '(window closed / no page)';
      log(`  [link] never reached Medal callback within ${cfg.javaLinkTimeoutMs}ms — window was on: ${where}`);
    }
    await closeBrowserQuiet(browser);
    browser = null;
  } catch (e) {
    log(`  [link] browser error: ${e.message}`);
    return { linked: false, reason: `browser_error: ${e.message}` };
  } finally {
    if (browser) await closeBrowserQuiet(browser);
  }

  if (!reachedCallback) {
    return { linked: false, reason: 'oauth_timeout_or_signin' };
  }

  // 3. Medal processes the code server-side; poll for the terminal status.
  const poll = await pollConnectionCallback(medalClient, callbackId, 60000);
  if (poll && poll.status === 'success') {
    log(`  [link] success: account ${userId} connected to the Microsoft identity`);
    return { linked: true, status: 'success', callbackId };
  }
  const msg =
    poll && poll.status === 'error'
      ? (poll.data && (poll.data.errorMessage || poll.data.message)) || 'error status'
      : 'callback_not_confirmed';
  log(`  [link] Microsoft rejected the link: ${msg}`);
  return { linked: false, reason: msg };
}

async function runJavaFlow({ cfg, args, proxies }) {
  const cookieFiles = listJavaCookieFiles(cfg, args.javaCookie);
  if (cookieFiles.length === 0) {
    throw new Error('no java cookie files found');
  }

  // Every account posts the SAME configured clip. Bail early if unset so we
  // don't half-create a directory of accounts before discovering this.
  const clipPath = args.clipPath || cfg.clip.path;
  if (!clipPath || clipPath === '/path/to/minecraft-clip.mp4' || !fs.existsSync(clipPath)) {
    throw new Error(
      'java flow: MEDAL_CLIP_PATH is not set to a real file ' +
        '(set MEDAL_CLIP_PATH in .env or pass --clip-path <file.mp4>)'
    );
  }

  const done = javaCookieFilesDone(cfg);
  const bad = loadBadJavaCookies(cfg);
  // Working pool: exports that have neither produced an account yet nor been
  // proven dead. loadJavaCookieInfo() still runs per attempt at link time.
  const pool = cookieFiles.filter((f) => {
    const b = path.basename(f);
    return !done.has(b) && !bad.has(b);
  });

  if (pool.length === 0) {
    log(
      `java flow: nothing to do — ${cookieFiles.length} cookie file(s), all already ` +
        'processed or proven bad.'
    );
    return { ok: 0, fail: 0, skipped: cookieFiles.length };
  }

  log(
    `java flow: ${cookieFiles.length} cookie file(s), ${pool.length} candidate(s), ` +
      `clip=${clipPath}` +
      (cfg.javaMaxAccounts ? `, maxAccounts=${cfg.javaMaxAccounts}` : '')
  );

  // Per-account flow (the operator's ordering):
  //   signup -> 5sim phone verify -> try exported MSA cookies until one links
  //   -> enroll DonutSMP quest -> upload clip + post to profile -> next.
  // The reward is redeemed in-game (never claimed here) as the Microsoft/Minecraft
  // identity that ended up linked to this account.
  const accountBaseArgs = {
    count: 1,
    proxy: null,
    analytics: args.analytics !== false,
    debugHcaptcha: false,
    captureFile: null,
    verifyPhone: true, // 5sim phone FIRST
    enrollQuest: false, // quest enroll happens after the MS link, below
    uploadClip: false, // clip upload/publish happens after the MS link, below
    deferAppend: true, // runJavaFlow finalizes + persists the record once linked
  };

  let ok = 0;
  let fail = 0;
  let accountIdx = 0;
  while (pool.length > 0 && (cfg.javaMaxAccounts === 0 || accountIdx < cfg.javaMaxAccounts)) {
    accountIdx += 1;
    log(`=== java account ${accountIdx} ===`);

    const { proxy: baseProxy, exhausted } = acquireProxy(
      proxies,
      cfg.proxyUsedFile,
      cfg.proxyReset
    );
    if (exhausted) {
      log(
        `java flow: proxy pool exhausted ` +
          `(set PROXY_RESET=1 to recycle). stopping at account ${accountIdx}.`
      );
      break;
    }
    // Reserve this egress IP for this account the moment it is assigned, so no
    // later account can reuse it even if this one fails.
    if (baseProxy) markProxyUsed(cfg.proxyUsedFile, baseProxy);
    const proxy = rotateProxySessionId(baseProxy);

    // 1) signup + 5sim phone verification. createAccount persists the failed
    //    entry itself on a hard phone failure and throws out of here.
    let record;
    try {
      record = await createAccount({ cfg, args: accountBaseArgs, proxy });
    } catch (e) {
      fail += 1;
      log(`java flow: signup/phone FAILED: ${e.message}`);
      await sleepMs(cfg.javaCookieDelayMs + Math.floor(Math.random() * 1000));
      continue; // proxy already reserved; try the next account
    }
    const authHeader = `${record.userId},${record.authKey}`;

    // 1b) Persist the phone-verified account IMMEDIATELY. createAccount defers
    //     its append for the java flow, so write the full record (email +
    //     password + tokens) here — BEFORE the headful Microsoft-link window
    //     opens. If that window freezes or the process dies, the paid account
    //     is already safe on disk and only the (optional) Minecraft link is
    //     lost. The record is enriched in place when the link succeeds.
    record.mode = 'java';
    record.linkPending = true; // saved; Microsoft/Minecraft identity not yet bound
    appendAccount(cfg.accountsFile, record);
    vlog(`java flow: phone-verified account saved (userId=${record.userId}, link pending)`);

    // 2) try candidate cookies until one links THIS account (dead ones drop
    //    out of the pool and are recorded so re-runs skip them).
    let linked = false;
    while (pool.length > 0 && !linked) {
      const candidate = pool[0];
      const cbase = path.basename(candidate);
      const info = loadJavaCookieInfo(candidate);
      if (!info.ok || !info.usable) {
        log(`java flow: drop cookie ${cbase} — ${info.error || info.sessionLabel}`);
        pool.shift();
        recordBadJavaCookie(cfg, cbase, info.error || 'not usable');
        continue;
      }
      log(
        `--- link attempt with ${cbase} ` +
          `(${info.ignHint ? 'ign ' + info.ignHint + ', ' : ''}${info.sessionLabel}) ---`
      );
      let res;
      try {
        res = await linkMinecraftAccountWithMsa({
          cfg,
          proxy,
          authHeader,
          userId: record.userId,
          cookieFile: candidate,
        });
      } catch (e) {
        res = { linked: false, reason: `link_error: ${e.message}` };
      }
      if (res && res.linked) {
        linked = true;
        record.mode = 'java';
        record.javaCookieFile = cbase;
        record.javaIgnHint = info.ignHint;
        record.javaSession = info.sessionLabel;
        record.javaCookieCount = info.cookieCount;
        pool.shift(); // this Microsoft identity is now bound to this account
        log(`java flow: LINKED ${cbase} -> userId=${record.userId}`);
      } else {
        const reason = (res && res.reason) || 'link_rejected';
        log(`java flow: cookie ${cbase} rejected (${reason})`);
        pool.shift();
        recordBadJavaCookie(cfg, cbase, reason);
        await sleepMs(1200);
      }
    }

    if (!linked) {
      fail += 1;
      // The phone-verified account was already persisted above — it stays a
      // good account in accounts.jsonl, just without a Microsoft identity yet.
      // Do NOT move it to failed-accounts.jsonl; the operator can link it later.
      log(
        'java flow: no cookie linked — account is SAVED but UNLINKED ' +
          `(userId=${record.userId}, ${record.email}). It stays usable; re-run ` +
          'or link it manually later.'
      );
      await sleepMs(cfg.javaCookieDelayMs + Math.floor(Math.random() * 1000));
      continue;
    }

    // 3) enroll the DonutSMP quest (account is phone-verified + MS-linked now)
    try {
      await enrollQuest({
        client: new MedalClient({ proxy, timezone: cfg.timezone }),
        authHeader,
        questId: cfg.questId,
      });
    } catch (e) {
      log(`java flow: quest enroll non-fatal: ${e.message}`);
      record.enrollError = e.message;
    }

    // 4) upload the clip and post it to the profile (PUBLIC)
    try {
      const clipResult = await uploadClip({
        cfg,
        userId: record.userId,
        authKey: record.authKey,
        clipPath: clipPath || null,
        log,
        proxy,
        contentType: CONTENT_TYPE_CLIP,
      });
      record.clipId = clipResult.contentId;
      record.clipUrl = clipResult.shareUrl;
      record.clipTaskId = clipResult.taskId;
    } catch (e) {
      log(`java flow: clip upload FAILED (non-fatal): ${e.message}`);
      record.clipUploadError = e.message;
    }

    // 4b) claim the quest reward (clip + post tasks are now satisfied)
    try {
      const qclient = new MedalClient({ proxy, timezone: cfg.timezone });
      let javaUsername = record.javaIgnHint || null;
      try {
        const linkRes = await qclient.http.get(`${MEDAL_API}/minecraft/link`, {
          headers: { accept: 'application/json', 'user-agent': MEDAL_UA, 'x-authentication': authHeader },
          validateStatus: () => true,
        });
        if (linkRes.status === 200 && linkRes.data && linkRes.data.java) {
          javaUsername = linkRes.data.java.username;
        }
      } catch (_) { /* fall back to javaIgnHint */ }
      const wait = await waitForQuestTasksComplete({
        client: qclient, authHeader, questId: cfg.questId,
        timeoutMs: 300000, pollMs: 10000,
        onTick: ({ attempt, summary, elapsedMs }) =>
          vlog(`java flow: tasks[${Math.round(elapsedMs / 1000)}s #${attempt}] ${summary.parts.join(' | ')}`),
      });
      const claim = await claimQuestReward({
        client: qclient, authHeader, questId: cfg.questId, input: javaUsername || '',
      });
      record.questClaim = {
        input: javaUsername,
        httpStatus: claim.status,
        accepted: claim.status === 200,
        claimedAt: claim.status === 200 ? new Date().toISOString() : null,
        response: claim.data,
      };
      log(
        `java flow: quest claim -> HTTP ${claim.status}` +
        (claim.status === 200 ? ' (accepted)' : `: ${JSON.stringify(claim.data).slice(0, 200)}`)
      );
    } catch (e) {
      log(`java flow: quest claim FAILED: ${e.message}`);
      record.questClaim = { error: e.message };
    }

    // 4c) redeem /medal in-game on the same proxy, then move the cookie to
    //     redeemed_java_cookies/ so it's clearly done.
    if (record.questClaim && record.questClaim.accepted) {
      try {
        const cookiePath = path.join(cfg.javaCookieDir, record.javaCookieFile);
        const redeemRes = await redeemMedal(cookiePath, proxy);
        record.medalRedeemed = redeemRes;
        if (redeemRes.success) {
          log(`java flow: /medal REDEEMED (${redeemRes.shards || 'shards'}) — moving cookie to redeemed/`);
          try {
            fs.mkdirSync(cfg.redeemedJavaCookiesDir, { recursive: true });
            const dst = path.join(cfg.redeemedJavaCookiesDir, record.javaCookieFile);
            if (fs.existsSync(cookiePath)) fs.renameSync(cookiePath, dst);
          } catch (moveErr) {
            log(`java flow: could not move cookie to redeemed/: ${moveErr.message}`);
          }
        } else {
          log(`java flow: /medal failed: ${redeemRes.error || 'unknown'}`);
        }
      } catch (e) {
        log(`java flow: /medal redemption error: ${e.message}`);
        record.medalRedeemed = { error: e.message };
      }
    }

    // 5) finalize: enrich the record that was persisted right after phone
    //    verification with the link/quest/clip results (no second line).
    record.linkPending = false;
    try {
      updateAccountEntry(cfg.accountsFile, record.userId, record);
      ok += 1;
      log(
        `ACCOUNT CREATED userId=${record.userId} cookie=${record.javaCookieFile} — ` +
          `redeem in-game as ${record.javaIgnHint || 'that Microsoft account'} with /medal`
      );
    } catch (e) {
      fail += 1;
      log(`java flow: could not persist account record: ${e.message}`);
    }

    await sleepMs(cfg.javaCookieDelayMs + Math.floor(Math.random() * 1000));
  }

  log(
    `java flow done. ok=${ok} fail=${fail} remainingCookies=${pool.length}`
  );
  return { ok, fail, skipped: cookieFiles.length - pool.length - ok };
}

/**
 * Java RELINK mode (--java-relink).
 *
 * No new signup / captcha / 5sim number. Re-runs ONLY the Microsoft/Minecraft
 * link step for accounts that are already saved in accounts.jsonl as
 * phone-verified but unlinked (mode='java' && linkPending), using the cookie
 * pool. When one links, the account is finished exactly like runJavaFlow:
 * enroll quest -> upload clip + post to profile -> finalize the saved record.
 * Accounts that still can't be linked stay pending in accounts.jsonl (nothing
 * is lost). This is the safe way to iterate on a stubborn cookie.
 */
async function runJavaRelink({ cfg, args }) {
  const cookieFiles = listJavaCookieFiles(cfg, args.javaCookie);
  if (cookieFiles.length === 0) throw new Error('no java cookie files found');

  const done = javaCookieFilesDone(cfg);
  const bad = loadBadJavaCookies(cfg);
  const pool = cookieFiles.filter((f) => {
    const b = path.basename(f);
    return !done.has(b) && !bad.has(b);
  });

  const pending = loadAccountsFile(cfg.accountsFile).filter(
    (r) => r && r.mode === 'java' && r.linkPending
  );
  if (pending.length === 0) {
    log(
      `java relink: no pending accounts (mode=java + linkPending) in ` +
        `${path.basename(cfg.accountsFile)}. Nothing to do.`
    );
    return { ok: 0, fail: 0, pending: 0 };
  }

  log(
    `java relink: ${pending.length} pending account(s), ${pool.length} cookie candidate(s)`
  );

  let ok = 0;
  for (const acct of pending) {
    const authHeader = `${acct.userId},${acct.authKey}`;
    log(`=== java relink account userId=${acct.userId} (${acct.email}) ===`);

    let linked = false;
    while (pool.length > 0 && !linked) {
      const candidate = pool[0];
      const cbase = path.basename(candidate);
      const info = loadJavaCookieInfo(candidate);
      if (!info.ok || !info.usable) {
        log(`java relink: drop cookie ${cbase} — ${info.error || info.sessionLabel}`);
        pool.shift();
        recordBadJavaCookie(cfg, cbase, info.error || 'not usable');
        continue;
      }
      log(`--- relink attempt with ${cbase} (${info.sessionLabel}) ---`);
      let res;
      try {
        res = await linkMinecraftAccountWithMsa({
          cfg,
          proxy: acct.proxy || null,
          authHeader,
          userId: acct.userId,
          cookieFile: candidate,
        });
      } catch (e) {
        res = { linked: false, reason: `link_error: ${e.message}` };
      }
      if (res && res.linked) {
        linked = true;
        acct.mode = 'java';
        acct.javaCookieFile = cbase;
        acct.javaIgnHint = info.ignHint;
        acct.javaSession = info.sessionLabel;
        acct.javaCookieCount = info.cookieCount;
        pool.shift();
        log(`java relink: LINKED ${cbase} -> userId=${acct.userId}`);
      } else {
        const reason = (res && res.reason) || 'link_rejected';
        log(`java relink: cookie ${cbase} rejected (${reason})`);
        pool.shift();
        recordBadJavaCookie(cfg, cbase, reason);
        await sleepMs(1200);
      }
    }

    if (!linked) {
      log(
        `java relink: no cookie linked for userId=${acct.userId} — ` +
          'account stays pending in accounts.jsonl.'
      );
      continue;
    }

    // Finish the account: quest enroll + clip upload/post, then finalize.
    try {
      await enrollQuest({
        client: new MedalClient({ proxy: acct.proxy || null, timezone: cfg.timezone }),
        authHeader,
        questId: cfg.questId,
      });
    } catch (e) {
      acct.enrollError = e.message;
      log(`java relink: quest enroll non-fatal: ${e.message}`);
    }
    try {
      const clipResult = await uploadClip({
        cfg,
        userId: acct.userId,
        authKey: acct.authKey,
        clipPath: args.clipPath || null,
        log,
        proxy: acct.proxy || null,
        contentType: CONTENT_TYPE_CLIP,
      });
      acct.clipId = clipResult.contentId;
      acct.clipUrl = clipResult.shareUrl;
      acct.clipTaskId = clipResult.taskId;
    } catch (e) {
      acct.clipUploadError = e.message;
      log(`java relink: clip upload FAILED (non-fatal): ${e.message}`);
    }

    // claim the quest reward (clip + post tasks now satisfied)
    try {
      const qclient = new MedalClient({ proxy: acct.proxy || null, timezone: cfg.timezone });
      let javaUsername = acct.javaIgnHint || null;
      try {
        const linkRes = await qclient.http.get(`${MEDAL_API}/minecraft/link`, {
          headers: { accept: 'application/json', 'user-agent': MEDAL_UA, 'x-authentication': authHeader },
          validateStatus: () => true,
        });
        if (linkRes.status === 200 && linkRes.data && linkRes.data.java) {
          javaUsername = linkRes.data.java.username;
        }
      } catch (_) { /* fall back to javaIgnHint */ }
      const wait = await waitForQuestTasksComplete({
        client: qclient, authHeader, questId: cfg.questId,
        timeoutMs: 300000, pollMs: 10000,
        onTick: ({ attempt, summary, elapsedMs }) =>
          vlog(`java relink: tasks[${Math.round(elapsedMs / 1000)}s #${attempt}] ${summary.parts.join(' | ')}`),
      });
      const claim = await claimQuestReward({
        client: qclient, authHeader, questId: cfg.questId, input: javaUsername || '',
      });
      acct.questClaim = {
        input: javaUsername,
        httpStatus: claim.status,
        accepted: claim.status === 200,
        claimedAt: claim.status === 200 ? new Date().toISOString() : null,
        response: claim.data,
      };
      log(
        `java relink: quest claim -> HTTP ${claim.status}` +
        (claim.status === 200 ? ' (accepted)' : `: ${JSON.stringify(claim.data).slice(0, 200)}`)
      );
    } catch (e) {
      log(`java relink: quest claim FAILED: ${e.message}`);
      acct.questClaim = { error: e.message };
    }

    // redeem /medal in-game on the same proxy, then move the cookie to redeemed/
    if (acct.questClaim && acct.questClaim.accepted) {
      try {
        const cookiePath = path.join(cfg.javaCookieDir, acct.javaCookieFile);
        const redeemRes = await redeemMedal(cookiePath, acct.proxy || null);
        acct.medalRedeemed = redeemRes;
        if (redeemRes.success) {
          log(`java relink: /medal REDEEMED (${redeemRes.shards || 'shards'}) — moving cookie to redeemed/`);
          try {
            fs.mkdirSync(cfg.redeemedJavaCookiesDir, { recursive: true });
            const dst = path.join(cfg.redeemedJavaCookiesDir, acct.javaCookieFile);
            if (fs.existsSync(cookiePath)) fs.renameSync(cookiePath, dst);
          } catch (moveErr) {
            log(`java relink: could not move cookie to redeemed/: ${moveErr.message}`);
          }
        } else {
          log(`java relink: /medal failed: ${redeemRes.error || 'unknown'}`);
        }
      } catch (e) {
        log(`java relink: /medal redemption error: ${e.message}`);
        acct.medalRedeemed = { error: e.message };
      }
    }

    acct.linkPending = false;
    try {
      updateAccountEntry(cfg.accountsFile, acct.userId, acct);
      ok += 1;
      log(
        `ACCOUNT READY userId=${acct.userId} cookie=${acct.javaCookieFile} — ` +
          `redeem in-game as ${acct.javaIgnHint || 'that Microsoft account'} with /medal`
      );
    } catch (e) {
      log(`java relink: could not finalize account record: ${e.message}`);
    }
  }

  log(
    `java relink done. linked=${ok} stillPending=${pending.length - ok} ` +
      `remainingCookies=${pool.length}`
  );
  return { ok, fail: pending.length - ok, pending: pending.length };
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv);

  // Verbose mode: --verbose CLI flag OR MEDAL_VERBOSE=1 env. When OFF (default)
  // we suppress the chatty per-step "ok" logs and keep only milestones,
  // retries, warnings, and errors. Routine failures still throw, so muting
  // the success spam doesn't hide real problems.
  if (args.verbose || /^(1|true|yes)$/i.test(process.env.MEDAL_VERBOSE || '')) {
    setVerboseLogging(true);
  }

  if (args.debugHcaptcha) {
    const defaultCaptureCandidates = [
      args.captureFile ? path.resolve(args.captureFile) : null,
      path.resolve('/root/httprequest.txt'),
      path.resolve(__dirname, '../httprequest.txt'),
      path.resolve(__dirname, 'httprequest.txt'),
    ]
      .filter(Boolean)
      .filter((p, idx, arr) => arr.indexOf(p) === idx);
    const ok = debugHcaptchaFromFiles(defaultCaptureCandidates);
    process.exit(ok ? 0 : 2);
  }

  const relinkMode = !!args.javaRelink;
  const javaMode = !relinkMode && !!args.javaCookie;
  const cfg = loadConfig({ requirePhone: relinkMode ? false : args.verifyPhone || javaMode });
  if (args.questId) cfg.questId = args.questId;

  // Relink mode operates on accounts already saved (no proxy acquisition).
  if (relinkMode) {
    try {
      const res = await runJavaRelink({ cfg, args });
      process.exit(res.ok > 0 ? 0 : res.pending === 0 ? 0 : 1);
    } catch (e) {
      log(`java relink FAILED: ${e.stack || e.message}`);
      process.exit(1);
    }
  }

  const proxies = args.proxy
    ? [normalizeProxy(args.proxy)]
    : loadProxiesFile(cfg.proxiesFile);

  if (proxies.length === 0) {
    log('no proxies configured - using direct connection');
  } else {
    log(`loaded ${proxies.length} proxy(ies) from ${path.basename(cfg.proxiesFile)}`);
    describeProxyMode(proxies, log);
  }

  // Java-cookie mode: one Medal account per uploaded Microsoft/Minecraft
  // session cookie (.txt). Signup -> phone verify -> clip upload/post -> STOP.
  if (javaMode) {
    try {
      const res = await runJavaFlow({ cfg, args, proxies });
      process.exit(res.fail > 0 && res.ok === 0 ? 1 : 0);
    } catch (e) {
      log(`java flow FAILED: ${e.stack || e.message}`);
      process.exit(1);
    }
  }

  // Legacy single-account loop: --count N fresh signups (optionally phone-
  // verified + clip posted via --verify-phone / --upload-clip). No claim.
  let ok = 0;
  let fail = 0;

  for (let i = 0; i < args.count; i++) {
    const { proxy: baseProxy, exhausted } = acquireProxy(
      proxies,
      cfg.proxyUsedFile,
      cfg.proxyReset
    );
    if (exhausted) {
      log(
        `all proxies in ${path.basename(cfg.proxiesFile)} are already used ` +
          `(set PROXY_RESET=1 to recycle). stopping at account ${i + 1}/${args.count}.`
      );
      break;
    }
    // Reserve this egress IP for this account the moment it is assigned, so no
    // later account can reuse it even if this one fails.
    if (baseProxy) markProxyUsed(cfg.proxyUsedFile, baseProxy);
    const proxy = rotateProxySessionId(baseProxy);
    log(`=== account ${i + 1}/${args.count} ===`);
    try {
      await createAccount({ cfg, args, proxy });
      ok += 1;
    } catch (e) {
      fail += 1;
      log(`FAILED: ${e.message}`);
    }
    // 2-5s random delay between accounts (exactly one at a time)
    if (i < args.count - 1) {
      const wait = 2000 + Math.floor(Math.random() * 3000);
      await new Promise((res) => setTimeout(res, wait));
    }
  }

  log(`done. ok=${ok} fail=${fail}`);
  process.exit(fail > 0 && ok === 0 ? 1 : 0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('fatal:', e && e.stack ? e.stack : e);
    process.exit(1);
  });
} else {
  module.exports = {
    constants: {
      MEDAL_UA,
      MEDAL_API,
      MEDAL_V2_API,
      AMPLITUDE_URL,
      MINECRAFT_CATEGORY_ID,
      AMPLITUDE_API_KEY,
      APP_VERSION,
      RECORDER_VERSION,
    },
    MedalClient,
    createAccount,
    verifyPhone,
    enrollQuest,
    claimQuestReward,
    getQuestStatus,
    summarizeQuestTasks,
    waitForQuestTasksComplete,
    uploadClip,
    loadConfig,
    loadProxiesFile,
    loadUsedProxies,
    saveUsedProxies,
    markProxyUsed,
    acquireProxy,
    normalizeProxy,
    proxyAgent,
    rotateProxySessionId,
    appendAccount,
    loadAccountsFile,
    removeFromFailedAccounts,
    updateAccountRecord,
    loadBadJavaCookies,
    recordBadJavaCookie,
    linkMinecraftAccountWithMsa,
    runJavaRelink,
    log,
    vlog,
    setVerboseLogging,
    workerContext,
  };
}

