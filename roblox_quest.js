#!/usr/bin/env node
/**
 * Roblox 100 Robux Friend Quest pipeline driver.
 *
 * For each requested run: creates (or reuses) a Medal account, applies a
 * referral from medalusername.txt, enrolls quest 3aNY15yfYS, performs the
 * Roblox OAuth dance with a Roblox account from accounts.txt, uploads a
 * Roblox clip, and claims the quest reward. Results -> roblox_quest_results.jsonl.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const signup = require('./medal_signup');
const {
  constants,
  MedalClient,
  createAccount,
  enrollQuest,
  claimQuestReward,
  waitForQuestTasksComplete,
  verifyPhone,
  loadReusableAccounts,
  loadCaptchaOnlyAccounts,
  removeFromFailedAccounts,
  uploadClip,
  loadConfig,
  loadProxiesFile,
  normalizeProxy,
  rotateProxySessionId,
  loadAccountsFile,
  updateAccountRecord,
  log,
  vlog,
  setVerboseLogging,
  workerContext,
} = signup;

const referral = require('./lib/medal_referral');
const pool = require('./lib/roblox_account_pool');
const oauth = require('./lib/medal_roblox_connect');

const DEFAULT_QUEST_ID = '3aNY15yfYS';
const DEFAULT_CATEGORY_ID = '1e2Ad6EOaE';
const DEFAULT_CLIP_PATH = '/root/medalbot/mp4clip/MedalTVRoblox20260523010152822.mp4';
const RESULTS_FILE = path.resolve(__dirname, 'roblox_quest_results.jsonl');

function defaultWorkers() {
  const raw = process.env.ROBLOX_QUEST_WORKERS || process.env.MEDAL_WORKERS || '1';
  return Math.max(1, Math.min(20, parseInt(raw, 10) || 1));
}

function parseArgs(argv) {
  const args = {
    workers: defaultWorkers(),
    workerStaggerMs: parseInt(process.env.ROBLOX_QUEST_WORKER_STAGGER_MS || '500', 10) || 500,
    proxy: null,
    noClip: false,
    noClaim: false,
    questId: DEFAULT_QUEST_ID,
    medalUsernamesPath: path.resolve(__dirname, 'medalusername.txt'),
    robloxAccountsPath: pool.DEFAULT_ACCOUNTS_PATH,
    joinedPath: pool.DEFAULT_JOINED_PATH,
    noJoinedFilter: false,
    statePath: path.resolve(__dirname, 'roblox_quest_progress.json'),
    verbose: false,
    oauthMethod: 'auto',
    dryRun: false,
    reuseExisting: false,
    reuseNoPhone: false,
    freshOnly: false,
    help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--workers' || a === '-w')
      args.workers = Math.max(1, Math.min(20, parseInt(argv[++i], 10) || 1));
    else if (a === '--worker-stagger-ms')
      args.workerStaggerMs = Math.max(0, parseInt(argv[++i], 10) || 0);
    else if (a === '--proxy' || a === '-p') args.proxy = argv[++i];
    else if (a === '--no-clip') args.noClip = true;
    else if (a === '--no-claim') args.noClaim = true;
    else if (a === '--quest-id') args.questId = argv[++i];
    else if (a === '--medal-usernames') args.medalUsernamesPath = argv[++i];
    else if (a === '--roblox-accounts') args.robloxAccountsPath = argv[++i];
    else if (a === '--joined-file') args.joinedPath = argv[++i];
    else if (a === '--no-joined-filter') args.noJoinedFilter = true;
    else if (a === '--state-file') args.statePath = argv[++i];
    else if (a === '--verbose' || a === '-v') args.verbose = true;
    else if (a === '--oauth-method') args.oauthMethod = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--reuse-existing') args.reuseExisting = true;
    else if (a === '--reuse-no-phone' || a === '--reuse-tier2') args.reuseNoPhone = true;
    else if (a === '--fresh-only' || a === '--no-reuse') args.freshOnly = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else {
      console.error(`[args] unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function printHelp() {
  console.log(
    `Usage: node roblox_quest.js [options]\n\n` +
      `Options:\n` +
      `  --workers N               In-process concurrency, max 20\n` +
      `                            (default: ROBLOX_QUEST_WORKERS or MEDAL_WORKERS from .env, else 1)\n` +
      `  --worker-stagger-ms N     Boot stagger between workers (default 500)\n` +
      `  --proxy <url>             Single proxy override (else proxies.txt rotation)\n` +
      `  --no-clip                 Skip clip upload\n` +
      `  --no-claim                Skip quest reward claim\n` +
      `  --quest-id <id>           Quest id (default ${DEFAULT_QUEST_ID})\n` +
      `  --medal-usernames <path>  Referral usernames file (default ./medalusername.txt)\n` +
      `  --roblox-accounts <path>  Roblox accounts file\n` +
      `                            (default ${pool.DEFAULT_ACCOUNTS_PATH})\n` +
      `  --joined-file <path>      Allowlist of Roblox usernames that have joined the\n` +
      `                            Medal TV group (default ${pool.DEFAULT_JOINED_PATH}).\n` +
      `                            Accounts NOT in this file are skipped.\n` +
      `  --no-joined-filter        Disable the joined.txt allowlist (use all accounts).\n` +
      `                            Claims will fail with errorId 62 for un-joined accounts.\n` +
      `  --state-file <path>       Pairing state JSON (default ./roblox_quest_progress.json)\n` +
      `  --oauth-method <m>        http | playwright | auto (default auto)\n` +
      `  --reuse-existing          Tier-1 ONLY (phone-verified, skip tier-2/fresh)\n` +
      `  --reuse-no-phone          Tier-2 ONLY (captcha-only, skip tier-1/fresh)\n` +
      `  --fresh-only              Skip reuse; always create new Medal accounts\n` +
      `                            (default: tier-1 → tier-2 → fresh, like bedrock-list)\n` +
      `  --dry-run                 Signup only; skip referral/enroll/connect/clip/claim\n` +
      `  --verbose, -v             Chatty logging\n` +
      `  --help, -h                Show this help\n`
  );
}

function pickProxy(args, proxies) {
  if (args.proxy) return rotateProxySessionId(normalizeProxy(args.proxy));
  if (!proxies || proxies.length === 0) return null;
  const base = proxies[Math.floor(Math.random() * proxies.length)];
  return rotateProxySessionId(base);
}

function buildRobloxClipCfg(baseClip) {
  return {
    ...(baseClip || {}),
    path: DEFAULT_CLIP_PATH,
    title: 'Roblox Gameplay',
    description: '#roblox',
    tags: ['roblox'],
    categoryId: DEFAULT_CATEGORY_ID,
    // sane fallbacks if env not set
    duration: baseClip && baseClip.duration ? baseClip.duration : 30,
    privacy: baseClip && baseClip.privacy != null ? baseClip.privacy : 0,
    timeoutMs: baseClip && baseClip.timeoutMs ? baseClip.timeoutMs : 120000,
    pollMs: baseClip && baseClip.pollMs ? baseClip.pollMs : 3000,
  };
}

function appendResult(rec) {
  fs.appendFileSync(RESULTS_FILE, JSON.stringify(rec) + '\n', 'utf8');
}

/** Medal account eligible for roblox quest pipeline reuse. */
function isRobloxQuestEligible(a) {
  return (
    a &&
    a.userId &&
    a.authKey &&
    a.phoneVerifiedAt &&
    !(a.robloxConnect && a.robloxConnect.ok === true)
  );
}

function dedupeByUserId(accounts) {
  const m = new Map();
  for (const a of accounts) {
    if (a && a.userId) m.set(String(a.userId), a);
  }
  return [...m.values()];
}

function loadTier1ReusePool(cfg) {
  const fromAccounts = loadAccountsFile(cfg.accountsFile).filter(isRobloxQuestEligible);
  const fromFailed = loadReusableAccounts(cfg.failedAccountsFile).filter(isRobloxQuestEligible);
  return dedupeByUserId([...fromAccounts, ...fromFailed]);
}

function buildQuestQueue({ cfg, args, availableRoblox }) {
  if (args.freshOnly) {
    const queue = [];
    for (let i = 0; i < availableRoblox; i++) queue.push({ medalAccount: null, reuseTier: 0 });
    log(`fresh-only: ${queue.length} new signup(s), reuse disabled`);
    return queue;
  }

  if (args.reuseExisting) {
    const tier1 = loadTier1ReusePool(cfg);
    const limit = Math.min(tier1.length, availableRoblox);
    const queue = tier1.slice(0, limit).map((a) => ({ medalAccount: a, reuseTier: 1 }));
    log(`reuse-existing: ${tier1.length} tier-1 eligible, processing ${queue.length}`);
    return queue;
  }

  if (args.reuseNoPhone) {
    const tier2 = loadCaptchaOnlyAccounts(cfg.failedAccountsFile);
    const limit = Math.min(tier2.length, availableRoblox);
    const queue = tier2.slice(0, limit).map((a) => ({ medalAccount: a, reuseTier: 2 }));
    log(`reuse-no-phone: ${tier2.length} tier-2 eligible, processing ${queue.length}`);
    return queue;
  }

  // Default: tier-1 (phone-verified) → tier-2 (captcha-only) → fresh signup.
  const useTier2 = String(process.env.MEDAL_USE_TIER2_REUSE ?? '1').trim() !== '0';
  const tier1 = loadTier1ReusePool(cfg);
  const tier2 = useTier2 ? loadCaptchaOnlyAccounts(cfg.failedAccountsFile) : [];

  const queue = [];
  let n1 = 0;
  let n2 = 0;
  let nFresh = 0;

  for (const a of tier1) {
    if (queue.length >= availableRoblox) break;
    queue.push({ medalAccount: a, reuseTier: 1 });
    n1 += 1;
  }
  for (const a of tier2) {
    if (queue.length >= availableRoblox) break;
    queue.push({ medalAccount: a, reuseTier: 2 });
    n2 += 1;
  }
  while (queue.length < availableRoblox) {
    queue.push({ medalAccount: null, reuseTier: 0 });
    nFresh += 1;
  }

  log(
    `reuse pool: tier1=${tier1.length} tier2=${tier2.length} | ` +
      `queue tier1=${n1} tier2=${n2} fresh=${nFresh} total=${queue.length}` +
      (useTier2 ? '' : ' (tier-2 disabled via MEDAL_USE_TIER2_REUSE=0)')
  );
  return queue;
}

/**
 * One full pipeline run against ONE Medal account (either freshly created or
 * reused). Returns the result record.
 */
async function runPipelineForAccount({
  cfg,
  args,
  proxy,
  medalUsernames,
  robloxPool,
  medalAccount, // {userId, authKey, username, ...} or null for "create new"
}) {
  const startedAt = new Date().toISOString();
  const errors = [];
  const result = {
    medalUserId: null,
    medalUsername: null,
    robloxUsername: null,
    robloxUserId: null,
    referrerUsername: null,
    referrerUserId: null,
    questId: args.questId,
    connect: null,
    clip: null,
    claim: null,
    success: false,
    errors,
    startedAt,
    finishedAt: null,
    proxy: proxy || null,
  };

  // Reserve a Roblox account up-front (atomic lease) so concurrent workers
  // can't pick the same account during the long Medal signup window.
  let robloxAcct = null;
  let robloxLeased = false;
  try {
    robloxAcct = await robloxPool.lease();
    if (!robloxAcct) {
      throw new Error('Roblox account pool exhausted: no un-used accounts left');
    }
    robloxLeased = true;
    result.robloxUsername = robloxAcct.username;

  // 1. Acquire / create a Medal account
  let userId, authKey, medalRecord;
  const needsPhone = !!(medalAccount && !medalAccount.phoneVerifiedAt);
  if (medalAccount) {
    userId = medalAccount.userId;
    authKey = medalAccount.authKey;
    medalRecord = medalAccount;
    log(
      `reusing medal account userId=${userId} username=${medalAccount.username}` +
      (needsPhone ? ' (tier-2: needs phone verify)' : '')
    );
  } else {
    log('creating new medal account...');
    const created = await createAccount({
      cfg,
      args: {
        ...args,
        analytics: true,
        verifyPhone: true,
        enrollQuest: false,
        uploadClip: false,
        claimQuest: null,
        bedrockBypass: 'auto',
      },
      proxy,
    });
    userId = created.userId;
    authKey = created.authKey;
    medalRecord = created;
  }
  result.medalUserId = userId;
  result.medalUsername = medalRecord.username || medalRecord.userName || null;
  const authHeader = `${userId},${authKey}`;
  const client = new MedalClient({ proxy, timezone: cfg.timezone });

  if (args.dryRun) {
    log(`DRY: skipping referral/enroll/connect/clip/claim for userId=${userId}`);
    result.success = true;
    result.finishedAt = new Date().toISOString();
    return result;
  }

  // 1b. Tier-2 reuse: verify phone via 5sim before continuing.
  if (needsPhone) {
    try {
      const phoneResult = await verifyPhone({ cfg, client, authHeader, userId });
      log(`phone ${phoneResult.phone} verified (tier-2 reuse)`);
      medalRecord = {
        ...medalRecord,
        phone: phoneResult.phone,
        phoneOrderId: phoneResult.orderId,
        phoneCode: phoneResult.code,
        phoneVerifyAttempts: phoneResult.attempts,
        phoneVerifiedAt: new Date().toISOString(),
        phoneVerifyResponse: phoneResult.response,
      };
      // Migrate from failed-accounts.jsonl → accounts.jsonl so the next run
      // sees this account as a Tier-1 candidate, not Tier-2.
      try {
        await removeFromFailedAccounts(cfg.failedAccountsFile, userId);
        const fs = require('fs');
        fs.appendFileSync(cfg.accountsFile, JSON.stringify(medalRecord) + '\n', 'utf8');
        vlog(`tier-2 reuse: migrated ${userId} from failed-accounts.jsonl → accounts.jsonl`);
      } catch (e) {
        vlog(`tier-2 reuse: migrate FAILED (non-fatal): ${e.message}`);
      }
    } catch (e) {
      log(`tier-2 phone verify FAILED: ${e.message}`);
      errors.push({ step: 'verify_phone', message: e.message });
      result.success = false;
      result.finishedAt = new Date().toISOString();
      return result;
    }
  }

  // 2. Referral (non-fatal)
  try {
    const refName = referral.pickRandomUsername(medalUsernames);
    result.referrerUsername = refName;
    const refId = await referral.resolveReferrerUserId(client.http, authHeader, refName);
    result.referrerUserId = refId;
    log(`referral: ${refName} -> ${refId}`);
    const ref = await referral.applyReferral(client.http, authHeader, userId, refId);
    vlog(`referral applied status=${ref.status} already=${!!ref.already}`);
  } catch (e) {
    log(`referral FAILED (non-fatal): ${e.message}`);
    errors.push({ step: 'referral', message: e.message });
  }

  // 3. Enroll quest
  try {
    await enrollQuest({ client, authHeader, questId: args.questId });
  } catch (e) {
    log(`enroll FAILED: ${e.message}`);
    errors.push({ step: 'enroll', message: e.message });
    result.finishedAt = new Date().toISOString();
    return result;
  }

  // 4. Connect roblox
  try {
    const conn = await oauth.requestRobloxConnection(client.http, authHeader);
    log(`connect: callbackId=${conn.callbackId}`);
    let oauthRes;
    const method = args.oauthMethod || 'auto';
    if (method === 'playwright') {
      oauthRes = await oauth.completeRobloxOAuthWithPlaywright({
        loginUrl: conn.loginUrl,
        robloxAccount: robloxAcct,
        proxy,
        log,
      });
    } else {
      try {
        oauthRes = await oauth.completeRobloxOAuth({
          loginUrl: conn.loginUrl,
          callbackId: conn.callbackId,
          robloxAccount: robloxAcct,
          proxy,
          log,
        });
      } catch (e) {
        const isChallenge = e instanceof oauth.OAuthChallengeError;
        if (method === 'auto' && (isChallenge || /\b403\b/.test(e.message))) {
          log(`oauth HTTP failed (${e.message}); falling back to playwright`);
          oauthRes = await oauth.completeRobloxOAuthWithPlaywright({
            loginUrl: conn.loginUrl,
            robloxAccount: robloxAcct,
            proxy,
            log,
          });
        } else {
          throw e;
        }
      }
    }
    result.connect = { ...oauthRes, callbackId: conn.callbackId };
    result.robloxUserId = oauthRes.robloxUserId || result.robloxUserId;
    if (oauthRes.robloxUsername) result.robloxUsername = oauthRes.robloxUsername;
    await robloxPool.markPaired(robloxAcct.username, userId);
    robloxLeased = false;
  } catch (e) {
    log(`connect FAILED: ${e.message}`);
    errors.push({ step: 'connect', message: e.message });
    result.finishedAt = new Date().toISOString();
    return result;
  }

  // 5. Clip
  if (!args.noClip) {
    try {
      const clipCfgRoblox = buildRobloxClipCfg(cfg.clip);
      const clipRes = await uploadClip({
        cfg: { ...cfg, clip: clipCfgRoblox },
        userId,
        authKey,
        clipPath: clipCfgRoblox.path,
        log,
      });
      result.clip = {
        contentId: clipRes.contentId,
        shareUrl: clipRes.shareUrl,
        taskId: clipRes.taskId,
        state: clipRes.state,
      };
    } catch (e) {
      log(`clip FAILED: ${e.message}`);
      errors.push({ step: 'clip', message: e.message });
    }
  } else {
    log('clip: skipped (--no-clip)');
  }

  // 6. Wait for Medal to register all 3 tasks as complete, then Claim.
  // The "Join the Medal TV group on Roblox" task is validated asynchronously
  // on Medal's backend; even when the Roblox account is already in the group
  // there is typically a 30s–4min delay between OAuth connect and the task
  // flipping to completedCount=1. Without this poll the claim races and
  // returns errorId 62 "Quest must have all tasks completed".
  if (!args.noClaim) {
    let tasksReady = true;
    try {
      const waitTimeoutMs = parseInt(process.env.QUEST_TASKS_WAIT_MS || '300000', 10);
      const waitPollMs    = parseInt(process.env.QUEST_TASKS_POLL_MS || '10000', 10);
      log(`claim: waiting up to ${Math.round(waitTimeoutMs/1000)}s for Medal to register all tasks...`);
      const w = await waitForQuestTasksComplete({
        client,
        authHeader,
        questId: args.questId,
        timeoutMs: waitTimeoutMs,
        pollMs: waitPollMs,
        onTick: ({ attempt, summary, elapsedMs }) => {
          log(`claim: tasks[${Math.round(elapsedMs/1000)}s #${attempt}] ${summary.parts.join(' ')}`);
        },
      });
      tasksReady = w.allDone;
      result.tasksWait = {
        allDone: w.allDone,
        attempts: w.attempts,
        elapsedMs: w.elapsedMs,
        finalParts: w.lastSummary ? w.lastSummary.parts : [],
      };
      if (!w.allDone) {
        const parts = w.lastSummary ? w.lastSummary.parts.join(' ') : '(no status)';
        log(`claim: tasks NOT complete after ${Math.round(w.elapsedMs/1000)}s — ${parts}. Skipping claim.`);
        errors.push({ step: 'claim_wait', message: `tasks_incomplete ${parts}` });
      }
    } catch (e) {
      tasksReady = false;
      log(`claim: task-status poll FAILED: ${e.message}`);
      errors.push({ step: 'claim_wait', message: e.message });
    }

    if (!tasksReady) {
      // Don't attempt the claim — would just return errorId 62.
    } else try {
      const r = await claimQuestReward({ client, authHeader, questId: args.questId, input: '' });
      const accepted = r.status === 200;
      result.claim = { status: r.status, accepted, data: r.data };
      if (!accepted) {
        const body = typeof r.data === 'string' ? r.data : JSON.stringify(r.data || {});
        if (/input.*required/i.test(body)) {
          log(`claim: input required (skipping per spec)`);
        } else {
          log(`claim rejected ${r.status}: ${body.slice(0, 200)}`);
          errors.push({ step: 'claim', message: `status=${r.status} body=${body.slice(0, 200)}` });
        }
      } else {
        log(`claim: CLAIMED`);
      }
    } catch (e) {
      log(`claim FAILED: ${e.message}`);
      errors.push({ step: 'claim', message: e.message });
    }
  } else {
    log('claim: skipped (--no-claim)');
  }

  result.success = errors.length === 0 || (result.connect && result.connect.ok);
  result.finishedAt = new Date().toISOString();
  // Best-effort: stamp the medal account record so reuse logic can skip it next time.
  try {
    if (result.connect && result.connect.ok) {
      updateAccountRecord(cfg.accountsFile, userId, {
        robloxConnect: {
          ok: true,
          robloxUsername: result.robloxUsername,
          robloxUserId: result.robloxUserId,
          callbackId: result.connect.callbackId,
          at: result.finishedAt,
        },
        robloxQuest: result.claim || null,
      });
    }
  } catch (_) {}
  return result;
  } finally {
    if (robloxLeased && robloxAcct) {
      await robloxPool.releaseLease(robloxAcct.username);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (args.verbose || /^(1|true|yes)$/i.test(process.env.MEDAL_VERBOSE || '')) {
    setVerboseLogging(true);
  }

  const cfg = loadConfig({ requirePhone: !args.reuseExisting });
  cfg.questId = args.questId;

  const proxies = args.proxy ? [normalizeProxy(args.proxy)] : loadProxiesFile(cfg.proxiesFile);
  if (proxies.length === 0) {
    log('no proxies configured - using direct connection');
  } else {
    log(`loaded ${proxies.length} proxy(ies)`);
  }

  const medalUsernames = referral.loadMedalUsernames(args.medalUsernamesPath);
  log(`loaded ${medalUsernames.length} medal referrer usernames`);

  const robloxPool = new pool.RobloxAccountPool({
    accountsPath: args.robloxAccountsPath,
    joinedPath: args.noJoinedFilter ? null : args.joinedPath,
    statePath: args.statePath,
  });
  if (args.noJoinedFilter) {
    log(`loaded ${robloxPool.accounts.length} roblox accounts (joined-filter DISABLED); ${Object.keys(robloxPool.state.used).length} already used`);
  } else {
    log(`loaded ${robloxPool.accounts.length}/${robloxPool.totalBeforeJoinFilter} roblox accounts in joined.txt; ${Object.keys(robloxPool.state.used).length} already used`);
  }

  const availableRoblox = robloxPool.availableCount();
  log(`workers=${args.workers}  roblox pool available=${availableRoblox}`);

  const queue = buildQuestQueue({ cfg, args, availableRoblox });
  if (queue.length === 0) {
    log('nothing to do');
    process.exit(0);
  }

  // Counters
  let created = 0;
  let linked = 0;
  let clipped = 0;
  let claimed = 0;
  let errs = 0;
  const wallStart = Date.now();

  // Hard exit on Ctrl+C — no graceful drain. Two SIGINTs in a row will also
  // bypass any lingering async work.
  process.on('SIGINT', () => {
    process.stderr.write('\nSIGINT — exiting now\n');
    process.exit(130);
  });
  const stopRequested = false;

  let nextIdx = 0;
  async function workerLoop(workerId) {
    const tag = `[Bot ${workerId}]`;
    while (!stopRequested) {
      const i = nextIdx++;
      if (i >= queue.length) return;
      const item = queue[i];
      await workerContext.run({ tag, workerId }, async () => {
        log(`=== run ${i + 1}/${queue.length} ===`);
        const proxy = pickProxy(args, proxies);
        let res = null;
        try {
          res = await runPipelineForAccount({
            cfg,
            args,
            proxy,
            medalUsernames,
            robloxPool,
            medalAccount: item.medalAccount,
          });
          created += 1;
          if (res.connect && res.connect.ok) linked += 1;
          if (res.clip && res.clip.contentId) clipped += 1;
          if (res.claim && res.claim.accepted) claimed += 1;
          if ((res.errors || []).length > 0) errs += 1;
        } catch (e) {
          errs += 1;
          log(`pipeline FAILED: ${e.message}`);
          res = {
            medalUserId: item.medalAccount ? item.medalAccount.userId : null,
            medalUsername: item.medalAccount ? item.medalAccount.username : null,
            robloxUsername: null,
            robloxUserId: null,
            referrerUsername: null,
            referrerUserId: null,
            questId: args.questId,
            connect: null,
            clip: null,
            claim: null,
            success: false,
            errors: [{ step: 'pipeline', message: e.message }],
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            proxy: proxy || null,
          };
        }
        if (res) appendResult(res);
      });
    }
  }

  const workers = [];
  for (let w = 1; w <= args.workers; w++) {
    if (w > 1 && args.workerStaggerMs > 0) {
      await new Promise((r) => setTimeout(r, args.workerStaggerMs));
    }
    workers.push(workerLoop(w));
  }
  await Promise.all(workers);

  const wallMs = Date.now() - wallStart;
  log(
    `created ${created} | linked ${linked} | clipped ${clipped} | ` +
      `claimed ${claimed} | errors ${errs} | wall ${Math.round(wallMs / 1000)}s | ` +
      `output ${path.basename(RESULTS_FILE)}`
  );
  process.exit(errs > 0 && created === 0 ? 1 : 0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('fatal:', e && e.stack ? e.stack : e);
    process.exit(1);
  });
}
