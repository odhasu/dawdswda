#!/usr/bin/env node
'use strict';

/**
 * Claim the Medal "Robux Referral" quest (default 2a_-PWI6vd) for cached
 * referrer accounts stored as JSONL (userId + authKey per line).
 *
 * Flow per account:
 *   1. GET  /api/v2/quests/:id          — read task progress + metadata
 *   2. POST /api/v2/quests/:id/enroll   — best-effort if not enrolled
 *   3. POST /api/v2/quests/:id/reward/claim  — NO_INPUT, empty body
 *
 * Usage:
 *   node referral_quest_claim.js
 *   node referral_quest_claim.js --accounts "/root/acc im using for medal referral.txt"
 *   node referral_quest_claim.js --account 314132574 --dry-run
 *   node referral_quest_claim.js --status-only
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const {
  MedalClient,
  loadConfig,
  enrollQuest,
  claimQuestReward,
  getQuestStatus,
  summarizeQuestTasks,
  updateAccountRecord,
  log,
  setVerboseLogging,
} = require('./medal_signup');

const DEFAULT_QUEST_ID = process.env.ROBUX_REFERRAL_QUEST_ID || '2a_-PWI6vd';
const DEFAULT_ACCOUNTS = process.env.REFERRAL_ACCOUNTS_FILE ||
  '/root/acc im using for medal referral.txt';
const RESULTS_FILE = path.resolve(__dirname, 'referral_quest_claim_results.jsonl');

function parseArgs(argv) {
  const args = {
    accountsPath: DEFAULT_ACCOUNTS,
    questId: DEFAULT_QUEST_ID,
    account: null,
    dryRun: false,
    statusOnly: false,
    skipEnroll: false,
    force: false,
    verbose: false,
    help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--accounts') args.accountsPath = argv[++i];
    else if (a === '--quest-id') args.questId = argv[++i];
    else if (a === '--account') args.account = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--status-only') args.statusOnly = true;
    else if (a === '--skip-enroll') args.skipEnroll = true;
    else if (a === '--force') args.force = true;
    else if (a === '--verbose' || a === '-v') args.verbose = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else {
      console.error(`[args] unknown: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function printHelp() {
  console.log(
    `Usage: node referral_quest_claim.js [options]\n\n` +
      `Options:\n` +
      `  --accounts <path>   Referrer accounts JSONL (default: ${DEFAULT_ACCOUNTS})\n` +
      `  --quest-id <id>     Quest id (default: ${DEFAULT_QUEST_ID})\n` +
      `  --account <userId>  Process one account only\n` +
      `  --status-only       Print quest progress, do not claim\n` +
      `  --dry-run           Fetch status only, skip claim POST\n` +
      `  --skip-enroll       Skip enroll POST\n` +
      `  --force             Attempt claim even if tasks look incomplete\n` +
      `  --verbose, -v       Verbose logging\n` +
      `  --help, -h          Show help\n\n` +
      `Env:\n` +
      `  REFERRAL_ACCOUNTS_FILE   Default accounts path\n` +
      `  ROBUX_REFERRAL_QUEST_ID  Default quest id\n`
  );
}

/** Load JSONL accounts; skip blank lines and # comments. */
function loadReferralAccounts(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`accounts file not found: ${filePath}`);
  }
  const out = [];
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    try {
      const rec = JSON.parse(t);
      if (rec.userId && rec.authKey) out.push(rec);
    } catch (_) {
      /* skip malformed */
    }
  }
  return out;
}

function appendResult(rec) {
  fs.appendFileSync(RESULTS_FILE, JSON.stringify(rec) + '\n', 'utf8');
}

function formatTasks(summary) {
  return summary.parts.join(' ');
}

function hasClaimableProgress(questData) {
  const meta = questData?.config?.reward?.metadata || {};
  if (typeof meta.unclaimedRobuxCount === 'number' && meta.unclaimedRobuxCount > 0) {
    return true;
  }
  const summary = summarizeQuestTasks(questData);
  return summary.allDone;
}

async function processAccount(acct, { cfg, args }) {
  const startedAt = new Date().toISOString();
  const authHeader = `${acct.userId},${acct.authKey}`;
  const client = new MedalClient({
    proxy: acct.proxy || null,
    timezone: cfg.timezone,
  });
  const name = acct.username || acct.userName || acct.userId;

  log(`--- ${name} (userId=${acct.userId}) ---`);

  const status = await getQuestStatus({ client, authHeader, questId: args.questId });
  if (status.status < 200 || status.status >= 300) {
    throw new Error(`GET quest -> ${status.status}: ${JSON.stringify(status.data).slice(0, 200)}`);
  }

  const data = status.data;
  const summary = summarizeQuestTasks(data);
  const meta = data?.config?.reward?.metadata || {};
  const claimedAt = data?.userStatus?.claimedAt || null;
  const enrolledAt = data?.userStatus?.enrolledAt || null;

  log(
    `tasks: ${formatTasks(summary)}` +
      (meta.invitedFriendsCount != null ? `  invited=${meta.invitedFriendsCount}` : '') +
      (meta.claimedRobuxCount != null ? `  claimedRobux=${meta.claimedRobuxCount}` : '') +
      (meta.unclaimedRobuxCount != null ? `  unclaimedRobux=${meta.unclaimedRobuxCount}` : '') +
      (claimedAt ? `  lastClaimedAt=${claimedAt}` : '') +
      (enrolledAt ? `  enrolledAt=${enrolledAt}` : '  not-enrolled')
  );

  const result = {
    userId: acct.userId,
    username: name,
    questId: args.questId,
    tasks: summary.parts,
    allTasksDone: summary.allDone,
    metadata: meta,
    claimedAtBefore: claimedAt,
    enrolledAt,
    claim: null,
    dryRun: args.dryRun,
    statusOnly: args.statusOnly,
    startedAt,
    finishedAt: null,
  };

  if (args.statusOnly || args.dryRun) {
    result.finishedAt = new Date().toISOString();
    return result;
  }

  if (!args.skipEnroll && !enrolledAt) {
    try {
      await enrollQuest({ client, authHeader, questId: args.questId });
      log('enrolled');
    } catch (e) {
      log(`enroll skipped: ${e.message.slice(0, 140)}`);
    }
  }

  if (!args.force && !hasClaimableProgress(data)) {
    log('skip claim: tasks incomplete and unclaimedRobuxCount=0');
    result.finishedAt = new Date().toISOString();
    return result;
  }

  const r = await claimQuestReward({
    client,
    authHeader,
    questId: args.questId,
    input: '',
  });
  const accepted = r.status === 200;
  result.claim = { status: r.status, accepted, data: r.data };

  if (accepted) {
    log(`CLAIMED (${meta.claimedRobuxCount || 0} -> check metadata in response)`);
    const newMeta = r.data?.config?.reward?.metadata;
    if (newMeta) {
      log(
        `post-claim: invited=${newMeta.invitedFriendsCount} ` +
          `claimedRobux=${newMeta.claimedRobuxCount} unclaimed=${newMeta.unclaimedRobuxCount}`
      );
    }
    try {
      updateAccountRecord(args.accountsPath, acct.userId, {
        robuxReferralQuest: {
          questId: args.questId,
          accepted: true,
          claimedAt: new Date().toISOString(),
          metadata: newMeta || meta,
          httpStatus: r.status,
        },
      });
    } catch (_) {}
  } else {
    const body = typeof r.data === 'string' ? r.data : JSON.stringify(r.data || {});
    log(`claim rejected ${r.status}: ${body.slice(0, 200)}`);
  }

  result.finishedAt = new Date().toISOString();
  return result;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (args.verbose) setVerboseLogging(true);

  const cfg = loadConfig({ skipRequired: true, requirePhone: false });
  let accounts = loadReferralAccounts(args.accountsPath);
  if (args.account) {
    accounts = accounts.filter((a) => String(a.userId) === String(args.account));
  }
  if (accounts.length === 0) {
    log('no accounts to process');
    process.exit(0);
  }

  log(`loaded ${accounts.length} referrer account(s) from ${args.accountsPath}`);
  log(`quest=${args.questId}${args.statusOnly ? ' (status-only)' : ''}${args.dryRun ? ' (dry-run)' : ''}`);

  let claimed = 0;
  let skipped = 0;
  let errors = 0;

  for (const acct of accounts) {
    try {
      const res = await processAccount(acct, { cfg, args });
      appendResult(res);
      if (res.claim && res.claim.accepted) claimed += 1;
      else if (!args.statusOnly && !args.dryRun && !res.claim) skipped += 1;
    } catch (e) {
      errors += 1;
      log(`FAILED userId=${acct.userId}: ${e.message}`);
      appendResult({
        userId: acct.userId,
        username: acct.username || acct.userId,
        questId: args.questId,
        error: e.message,
        finishedAt: new Date().toISOString(),
      });
    }
  }

  log(`done: claimed ${claimed} | skipped ${skipped} | errors ${errors} | output ${RESULTS_FILE}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.stack || e.message);
    process.exit(1);
  });
}

module.exports = { loadReferralAccounts, processAccount };
