#!/usr/bin/env node
'use strict';
/**
 * Complete the DonutSMP quest for a phone-verified + Minecraft-linked account.
 *
 *   node medal_quest.js [userId]
 *
 * Flow (all through the account's stored proxy so the IP matches the signup):
 *   create a real CLIP (contentType 15) -> post PUBLIC -> wait for Medal to
 *   register the quest tasks -> claim the reward with the Java username.
 */
require('dotenv').config();

const fs = require('fs');
const {
  MedalClient,
  loadConfig,
  loadAccountsFile,
  uploadClip,
  enrollQuest,
  getQuestStatus,
  summarizeQuestTasks,
  waitForQuestTasksComplete,
  claimQuestReward,
  log,
  setVerboseLogging,
} = require('./medal_signup');

const CLIP = 15;
const MEDAL_API = 'https://medal.tv/api';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36';

async function main() {
  setVerboseLogging(true);
  const cfg = loadConfig();
  const userId = process.argv[2] || '794210119';

  const acct = loadAccountsFile(cfg.accountsFile).find(
    (r) => String(r.userId) === String(userId)
  );
  if (!acct) {
    console.error(`account ${userId} not found in ${cfg.accountsFile}`);
    process.exit(1);
  }
  const proxy = acct.proxy || null;
  const authHeader = `${acct.userId},${acct.authKey}`;
  const client = new MedalClient({ proxy, timezone: cfg.timezone });

  log(
    `=== quest run  userId=${acct.userId} (${acct.email})  quest=${cfg.questId}  proxy=${proxy ? 'yes' : 'DIRECT (no proxy!)'} ===`
  );

  // 1. Confirm the Minecraft link and grab the real Java username for the claim.
  let javaUsername = acct.javaIgnHint || null;
  try {
    const r = await client.http.get(`${MEDAL_API}/minecraft/link`, {
      headers: { accept: 'application/json', 'user-agent': UA, 'x-authentication': authHeader },
      validateStatus: () => true,
    });
    if (r.status === 200 && r.data && r.data.java) {
      javaUsername = r.data.java.username;
      log(`minecraft link ok: username=${javaUsername} uuid=${r.data.java.uuid}`);
    } else {
      log(`minecraft/link -> ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
    }
  } catch (e) {
    log(`minecraft/link error: ${e.message}`);
  }

  // 2. Create + post a real CLIP (type 15) through the account proxy.
  const clipPath = cfg.clip.path;
  if (!clipPath || !fs.existsSync(clipPath)) {
    console.error(`clip file not found: ${clipPath}`);
    process.exit(1);
  }
  log(`creating CLIP (type 15) from ${clipPath} ...`);
  const clip = await uploadClip({ cfg, userId, authKey: acct.authKey, clipPath, log, contentType: CLIP, proxy });
  log(`clip posted: ${clip.shareUrl}  contentId=${clip.contentId}`);

  // 3. Enroll (non-fatal; already enrolled is fine).
  try {
    await enrollQuest({ client, authHeader, questId: cfg.questId });
    log('quest enrolled');
  } catch (e) {
    log(`enroll (non-fatal): ${e.message}`);
  }

  // 4. Wait for Medal to flip the quest tasks (clip + post).
  log('waiting for Medal to register quest tasks...');
  const wait = await waitForQuestTasksComplete({
    client,
    authHeader,
    questId: cfg.questId,
    timeoutMs: 300000,
    pollMs: 10000,
    onTick: ({ attempt, summary, elapsedMs }) =>
      log(`tasks[${Math.round(elapsedMs / 1000)}s #${attempt}] ${summary.parts.join(' | ')}`),
  });
  log(
    `tasks allDone=${wait.allDone}  (${wait.lastSummary ? wait.lastSummary.parts.join(' | ') : 'n/a'})`
  );

  // 5. Claim the reward with the Java username.
  log(`claiming quest with input=${javaUsername} ...`);
  const claim = await claimQuestReward({ client, authHeader, questId: cfg.questId, input: javaUsername });
  log(`claim -> HTTP ${claim.status}: ${JSON.stringify(claim.data).slice(0, 600)}`);

  // 6. Final status.
  const st = await getQuestStatus({ client, authHeader, questId: cfg.questId });
  log(
    `final: ${summarizeQuestTasks(st.data).parts.join(' | ')}  claimedAt=${st.data?.userStatus?.claimedAt || 'n/a'}`
  );
}

main().catch((e) => {
  console.error('fatal:', e.stack || e.message);
  process.exit(1);
});
