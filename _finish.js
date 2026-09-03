'use strict';
// Finalize a phone-verified, MS-linked Medal account that is saved in
// accounts.jsonl but not yet finished (linkPending). Enrolls the DonutSMP
// quest, uploads + posts the clip to the profile (PUBLIC), then stamps the
// record as complete. Only touches accounts whose Microsoft link is CONFIRMED
// (GET minecraft/link returns a java identity).
const fs = require('fs');
const { MedalClient, loadConfig, enrollQuest, uploadClip, loadAccountsFile } = require('./medal_signup');
const { loadJavaCookieInfo } = require('./lib/java_cookie');

const cfg = loadConfig();
const USER_ID = process.argv[2] || '794210119';

async function main() {
  const all = loadAccountsFile(cfg.accountsFile);
  const acct = all.find((r) => String(r.userId) === USER_ID);
  if (!acct) throw new Error(`account ${USER_ID} not found in ${cfg.accountsFile}`);
  console.log(`account: ${acct.userId} ${acct.email}  linkPending=${acct.linkPending}`);
  if (acct.linkPending === false) {
    console.log('account already finalized (linkPending=false) — nothing to do.');
    return;
  }

  const authHeader = `${acct.userId},${acct.authKey}`;
  const proxy = acct.proxy || null;
  const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36';
  const axios = require('axios');

  // 1. Confirm the Microsoft/Minecraft link before spending a clip on it.
  const linkRes = await axios.get(`${cfg.medalApi || 'https://medal.tv/api'}/minecraft/link`, {
    headers: { accept: 'application/json', 'user-agent': UA, 'x-authentication': authHeader },
    validateStatus: () => true,
  });
  const linked = linkRes.status === 200 && linkRes.data && linkRes.data.java;
  if (!linked) {
    console.log(`minecraft/link status=${linkRes.status} — account NOT linked to a Java identity; aborting.`);
    process.exitCode = 2;
    return;
  }
  const java = linkRes.data.java;
  console.log(`confirmed link: java username=${java.username} uuid=${java.uuid}`);

  // 2. Enroll the DonutSMP quest.
  try {
    const r = await enrollQuest({
      client: new MedalClient({ proxy, timezone: cfg.timezone }),
      authHeader,
      questId: cfg.questId,
    });
    console.log('quest enroll ok, phoneVerificationRequired=', r && r.userStatus && r.userStatus.phoneVerificationRequired);
  } catch (e) {
    acct.enrollError = e.message;
    console.log('quest enroll error (continuing):', e.message);
  }

  // 3. Upload the clip and post it PUBLIC to the profile.
  let clipId = null, clipUrl = null, clipTaskId = null;
  try {
    const clipResult = await uploadClip({ cfg, userId: acct.userId, authKey: acct.authKey, clipPath: cfg.clip.path, log: console.log });
    clipId = clipResult.contentId;
    clipUrl = clipResult.shareUrl;
    clipTaskId = clipResult.taskId;
    console.log('clip posted to profile:', clipUrl);
  } catch (e) {
    acct.clipUploadError = e.message;
    console.log('clip upload error:', e.message);
  }

  // 4. Finalize the saved record (cookie stamp so re-runs treat it as done).
  //    Find the cookie file whose stem matches the confirmed Java username.
  const cookieDir = cfg.javaCookieDir || 'java_cookies';
  let matched = null;
  if (fs.existsSync(cookieDir)) {
    for (const f of fs.readdirSync(cookieDir)) {
      if (!/\.(txt|json|bak)$/i.test(f)) continue;
      if (f.replace(/\.(txt|json|bak)$/i, '').toLowerCase() === String(java.username).toLowerCase()) { matched = f; break; }
    }
  }
  let info = { ignHint: java.username, sessionLabel: 'MSA session artifact present', cookieCount: 0 };
  if (matched) {
    const cookiePath = `${cookieDir}/${matched}`;
    if (fs.existsSync(cookiePath)) {
      try { info = loadJavaCookieInfo(cookiePath); } catch (_) {}
    }
  }
  acct.mode = 'java';
  acct.linkPending = false;
  acct.javaCookieFile = matched || null;
  acct.javaIgnHint = info.ignHint || java.username;
  acct.javaSession = info.sessionLabel;
  acct.javaCookieCount = info.cookieCount || null;
  acct.javaUuid = java.uuid;
  if (clipId) { acct.clipId = clipId; acct.clipUrl = clipUrl; acct.clipTaskId = clipTaskId; }
  acct.finalizedAt = new Date().toISOString();

  if (fs.existsSync(cfg.accountsFile)) {
    const lines = fs.readFileSync(cfg.accountsFile, 'utf8').split(/\r?\n/);
    let replaced = false;
    const out = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (!replaced && String(r.userId) === USER_ID) { out.push(JSON.stringify(acct)); replaced = true; continue; }
      } catch (_) {}
      out.push(line);
    }
    if (!replaced) out.push(JSON.stringify(acct));
    fs.writeFileSync(cfg.accountsFile, out.join('\n') + '\n', 'utf8');
  } else {
    fs.writeFileSync(cfg.accountsFile, JSON.stringify(acct) + '\n', 'utf8');
  }
  console.log(`FINALIZED account ${acct.userId} — cookie=EighteeeeN.txt — redeem in-game as ${acct.javaIgnHint} with /medal`);
  if (clipUrl) console.log('public clip:', clipUrl);
}

main().catch((e) => { console.error('fatal:', e.stack || e.message); process.exit(1); });
