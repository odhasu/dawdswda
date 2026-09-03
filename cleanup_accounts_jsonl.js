#!/usr/bin/env node
/**
 * One-shot cleanup: walks /root/medalbot/accounts.jsonl and:
 *   - Keeps lines where questClaim.accepted === true (real, usable accounts).
 *   - Moves all other lines to failed-accounts.jsonl (with failReason set).
 *   - Backs the original file up to accounts.jsonl.bak-<timestamp> first.
 *
 * Run once after pulling the new "only-save-claimed" patch, then delete this
 * script if you don't want it sitting around.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ACCOUNTS = path.resolve(__dirname, 'accounts.jsonl');
const FAILED = path.resolve(__dirname, 'failed-accounts.jsonl');

if (!fs.existsSync(ACCOUNTS)) {
  console.error(`no such file: ${ACCOUNTS}`);
  process.exit(1);
}

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const backup = `${ACCOUNTS}.bak-${ts}`;
fs.copyFileSync(ACCOUNTS, backup);
console.log(`backup -> ${backup}`);

const raw = fs.readFileSync(ACCOUNTS, 'utf8');
const lines = raw.split(/\r?\n/).filter(Boolean);

let kept = 0;
let moved = 0;
let bad = 0;

const keepLines = [];
const failedLines = [];

for (const line of lines) {
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    bad += 1;
    keepLines.push(line); // preserve un-parseable rows verbatim
    continue;
  }

  const accepted = !!(rec && rec.questClaim && rec.questClaim.accepted);

  if (accepted) {
    keepLines.push(JSON.stringify(rec));
    kept += 1;
  } else {
    const reason =
      (rec.questClaim && rec.questClaim.error) ||
      (rec.questClaim && rec.questClaim.errorMessage) ||
      rec.phoneVerifyError ||
      rec.clipUploadError ||
      'claim_not_accepted';
    const out = {
      ...rec,
      failReason: reason,
      failedAt: rec.questClaim && rec.questClaim.claimedAt ? rec.questClaim.claimedAt : new Date().toISOString(),
      movedFromAccountsJsonlAt: new Date().toISOString(),
    };
    failedLines.push(JSON.stringify(out));
    moved += 1;
  }
}

fs.writeFileSync(ACCOUNTS, keepLines.length ? keepLines.join('\n') + '\n' : '', 'utf8');
if (failedLines.length) {
  fs.appendFileSync(FAILED, failedLines.join('\n') + '\n', 'utf8');
}

console.log(`done. kept=${kept}  moved-to-failed=${moved}  unparseable=${bad}`);
console.log(`accounts.jsonl now has ${kept} entries (all claim-accepted).`);
console.log(`failed-accounts.jsonl had ${moved} new entries appended.`);
