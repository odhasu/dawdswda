#!/usr/bin/env node
'use strict';
/**
 * CHECKPOINT / experimental workflow — Minecraft-link-FIRST.
 *
 * Reorders the Java flow so the Minecraft/Microsoft link happens BEFORE the
 * 5sim phone buy, so a cookie that is already bound to another Medal account
 * (errorCode 63) is rejected before we spend ~$0.08 on a phone number.
 *
 * New order: signup -> link Minecraft -> 5sim phone -> enroll -> clip(15) ->
 * post PUBLIC -> claim.
 *
 *   node medal_signup_minecraft_first.js --java-cookie ./java_cookies --verbose
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { loadJavaCookieInfo } = require('./lib/java_cookie');
const {
  MedalClient,
  createAccount,
  verifyPhone,
  enrollQuest,
  uploadClip,
  claimQuestReward,
  waitForQuestTasksComplete,
  loadConfig,
  loadProxiesFile,
  acquireProxy,
  markProxyUsed,
  rotateProxySessionId,
  appendAccount,
  loadAccountsFile,
  loadBadJavaCookies,
  recordBadJavaCookie,
  linkMinecraftAccountWithMsa,
  log,
  setVerboseLogging,
} = require('./medal_signup');

const CONTENT_TYPE_CLIP = 15;
const MEDAL_API = 'https://medal.tv/api';
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

function listJavaCookieFiles(cfg, cliPath) {
  const targets = [];
  const push = (f) => { if (/\.(txt|json|bak)$/i.test(f)) targets.push(f); };
  if (cliPath) {
    const abs = path.resolve(cliPath);
    if (!fs.existsSync(abs)) throw new Error(`--java-cookie path not found: ${abs}`);
    if (fs.statSync(abs).isDirectory()) {
      for (const f of fs.readdirSync(abs).sort()) push(path.join(abs, f));
    } else push(abs);
  } else {
    if (!fs.existsSync(cfg.javaCookieDir)) throw new Error(`java cookie dir not found: ${cfg.javaCookieDir}`);
    for (const f of fs.readdirSync(cfg.javaCookieDir).sort()) push(path.join(cfg.javaCookieDir, f));
  }
  return targets;
}

function javaCookieFilesDone(cfg) {
  const done = new Set();
  for (const rec of loadAccountsFile(cfg.accountsFile)) {
    if (rec && rec.mode === 'java' && rec.javaCookieFile) done.add(rec.javaCookieFile);
  }
  return done;
}

function updateAccountEntry(filePath, userId, updatedRecord) {
  if (!fs.existsSync(filePath)) { appendAccount(filePath, updatedRecord); return true; }
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
    } catch { /* keep */ }
    out.push(line);
  }
  if (!replaced) out.push(JSON.stringify(updatedRecord));
  fs.writeFileSync(filePath, out.join('\n') + '\n', 'utf8');
  return replaced;
}

async function main() {
  let javaCookie = null;
  let verbose = false;
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--java-cookie' || a === '-j') javaCookie = process.argv[++i];
    else if (a === '--verbose' || a === '-v') verbose = true;
  }
  if (verbose) setVerboseLogging(true);

  const cfg = loadConfig({ requirePhone: true });
  const cookieFiles = listJavaCookieFiles(cfg, javaCookie);
  if (!cookieFiles.length) throw new Error('no java cookie files found');

  const clipPath = cfg.clip.path;
  if (!clipPath || clipPath === '/path/to/minecraft-clip.mp4' || !fs.existsSync(clipPath)) {
    throw new Error('MEDAL_CLIP_PATH is not set to a real file');
  }

  const done = javaCookieFilesDone(cfg);
  const bad = loadBadJavaCookies(cfg);
  const pool = cookieFiles.filter((f) => !done.has(path.basename(f)) && !bad.has(path.basename(f)));
  if (!pool.length) {
    log(`minecraft-first: nothing to do — ${cookieFiles.length} cookie(s), all done or bad.`);
    return;
  }

  const proxies = loadProxiesFile(cfg.proxiesFile);
  log(`minecraft-first flow: ${cookieFiles.length} cookie(s), ${pool.length} candidate(s), clip=${clipPath}`);

  let ok = 0;
  let fail = 0;
  let accountIdx = 0;
  while (pool.length > 0 && (cfg.javaMaxAccounts === 0 || accountIdx < cfg.javaMaxAccounts)) {
    accountIdx++;
    log(`=== account ${accountIdx} (minecraft-first) ===`);

    const { proxy: baseProxy, exhausted } = acquireProxy(proxies, cfg.proxyUsedFile, cfg.proxyReset);
    if (exhausted) { log('proxy pool exhausted — stopping'); break; }
    if (baseProxy) markProxyUsed(cfg.proxyUsedFile, baseProxy);
    const proxy = rotateProxySessionId(baseProxy);

    // 1) SIGNUP ONLY — no phone, no clip, no enroll.
    const baseArgs = {
      count: 1, proxy: null, analytics: true, debugHcaptcha: false, captureFile: null,
      verifyPhone: false, enrollQuest: false, uploadClip: false, deferAppend: true,
    };
    let record;
    try {
      record = await createAccount({ cfg, args: baseArgs, proxy });
    } catch (e) {
      fail += 1;
      log(`signup FAILED: ${e.message}`);
      await sleepMs(cfg.javaCookieDelayMs + Math.floor(Math.random() * 1000));
      continue;
    }
    const authHeader = `${record.userId},${record.authKey}`;
    record.mode = 'java';
    record.linkPending = true;
    record.phonePending = true;
    appendAccount(cfg.accountsFile, record);
    log(`account created (unverified): userId=${record.userId} ${record.email}`);

    // 2) LINK MINECRAFT FIRST — reject used cookies before spending phone money.
    let linked = false;
    while (pool.length > 0 && !linked) {
      const candidate = pool[0];
      const cbase = path.basename(candidate);
      const info = loadJavaCookieInfo(candidate);
      if (!info.ok || !info.usable) {
        log(`drop cookie ${cbase} — ${info.error || info.sessionLabel}`);
        pool.shift();
        recordBadJavaCookie(cfg, cbase, info.error || 'not usable');
        continue;
      }
      log(`--- link attempt with ${cbase} ---`);
      let res;
      try {
        res = await linkMinecraftAccountWithMsa({ cfg, proxy, authHeader, userId: record.userId, cookieFile: candidate });
      } catch (e) {
        res = { linked: false, reason: `link_error: ${e.message}` };
      }
      if (res && res.linked) {
        linked = true;
        record.javaCookieFile = cbase;
        record.javaIgnHint = info.ignHint;
        record.javaSession = info.sessionLabel;
        record.javaCookieCount = info.cookieCount;
        pool.shift();
        log(`LINKED ${cbase} -> userId=${record.userId}`);
      } else {
        const reason = (res && res.reason) || 'link_rejected';
        log(`cookie ${cbase} rejected (${reason})`);
        pool.shift();
        recordBadJavaCookie(cfg, cbase, reason);
        await sleepMs(1200);
      }
    }

    if (!linked) {
      fail += 1;
      log(`no cookie linked — account SAVED unverified+unlinked (NO phone spent). userId=${record.userId}`);
      updateAccountEntry(cfg.accountsFile, record.userId, record);
      await sleepMs(cfg.javaCookieDelayMs + Math.floor(Math.random() * 1000));
      continue;
    }

    // 3) PHONE VERIFY — only after a cookie successfully linked.
    const client = new MedalClient({ proxy, timezone: cfg.timezone });
    try {
      const phoneResult = await verifyPhone({ cfg, client, authHeader, userId: record.userId });
      Object.assign(record, phoneResult);
      record.phonePending = false;
      log(`phone verified: ${record.phone}`);
    } catch (e) {
      fail += 1;
      log(`phone verification FAILED: ${e.message}`);
      record.phoneVerifyError = e.message;
      updateAccountEntry(cfg.accountsFile, record.userId, record);
      continue;
    }

    // 4) ENROLL + CLIP(15) + POST + CLAIM.
    try { await enrollQuest({ client, authHeader, questId: cfg.questId }); } catch (e) { record.enrollError = e.message; log(`enroll non-fatal: ${e.message}`); }

    try {
      const clipResult = await uploadClip({ cfg, userId: record.userId, authKey: record.authKey, clipPath, log, proxy, contentType: CONTENT_TYPE_CLIP });
      record.clipId = clipResult.contentId;
      record.clipUrl = clipResult.shareUrl;
      record.clipTaskId = clipResult.taskId;
    } catch (e) { record.clipUploadError = e.message; log(`clip upload FAILED (non-fatal): ${e.message}`); }

    try {
      let javaUsername = record.javaIgnHint || null;
      try {
        const linkRes = await client.http.get(`${MEDAL_API}/minecraft/link`, {
          headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'x-authentication': authHeader },
          validateStatus: () => true,
        });
        if (linkRes.status === 200 && linkRes.data && linkRes.data.java) javaUsername = linkRes.data.java.username;
      } catch (_) { /* fall back to ignHint */ }
      const wait = await waitForQuestTasksComplete({
        client, authHeader, questId: cfg.questId, timeoutMs: 300000, pollMs: 10000,
        onTick: ({ attempt, summary, elapsedMs }) => log(`tasks[${Math.round(elapsedMs / 1000)}s #${attempt}] ${summary.parts.join(' | ')}`),
      });
      const claim = await claimQuestReward({ client, authHeader, questId: cfg.questId, input: javaUsername || '' });
      record.questClaim = { input: javaUsername, httpStatus: claim.status, accepted: claim.status === 200, claimedAt: claim.status === 200 ? new Date().toISOString() : null, response: claim.data };
      log(`quest claim -> HTTP ${claim.status}${claim.status === 200 ? ' (accepted)' : `: ${JSON.stringify(claim.data).slice(0, 200)}`}`);
    } catch (e) { record.questClaim = { error: e.message }; log(`quest claim FAILED: ${e.message}`); }

    record.linkPending = false;
    updateAccountEntry(cfg.accountsFile, record.userId, record);
    ok += 1;
    log(`DONE userId=${record.userId} cookie=${record.javaCookieFile}`);
    await sleepMs(cfg.javaCookieDelayMs + Math.floor(Math.random() * 1000));
  }

  log(`minecraft-first done. ok=${ok} fail=${fail} remainingCookies=${pool.length}`);
  process.exit(fail > 0 && ok === 0 ? 1 : 0);
}

main().catch((e) => { console.error('fatal:', e.stack || e.message); process.exit(1); });
