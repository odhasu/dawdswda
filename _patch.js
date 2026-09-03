'use strict';
// Ordered, marker-anchored refactor of medal_signup.js:
//   - remove Bedrock-username bypass machinery + bedrock-list/claim engine
//   - add Java-cookie flow (signup + phone verify + clip upload/post, STOP)
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'medal_signup.js');
const fragDir = path.join(ROOT, '_frag');

let s = fs.readFileSync(SRC, 'utf8');

function fail(msg) {
  console.error('PATCH ABORT: ' + msg);
  process.exit(1);
}
function one(marker, from) {
  const i = s.indexOf(marker, from || 0);
  if (i < 0) fail('marker not found: ' + marker);
  return i;
}
function readFrag(name) {
  return fs.readFileSync(path.join(fragDir, name), 'utf8');
}
// Line-start of the line containing idx, then climb upward while the previous
// line is a contiguous '//' comment so we swallow whole comment banners.
function regionStartOfComment(idx) {
  let start = s.lastIndexOf('\n', idx - 1) + 1;
  for (;;) {
    const prevNl = s.lastIndexOf('\n', start - 1);
    if (prevNl < 0) break;
    const prevLine = s.slice(prevNl + 1, start);
    if (/^\s*\/\//.test(prevLine)) start = prevNl + 1;
    else break;
  }
  return start;
}

// 1) require java_cookie loader
{
  const anchor = "const { FiveSim } = require('./lib/sms5sim');";
  const i = one(anchor);
  s =
    s.slice(0, i + anchor.length) +
    "\nconst { loadJavaCookieInfo } = require('./lib/java_cookie');" +
    s.slice(i + anchor.length);
}

// 2) drop bedrock consts/variants + old parseArgs, insert new parseArgs
{
  const start = regionStartOfComment(one('// Bedrock-username bypass variants'));
  const end = one('function loadConfig(options = {}) {', start);
  const frag = readFrag('f_parseargs.js');
  s = s.slice(0, start) + '\n' + frag + '\n' + s.slice(end);
}

// 3) swap bedrock config fields for java-flow config fields
{
  const start = regionStartOfComment(one('    // Default: the bedrock username list maintained'));
  const end = one('    proxiesFile: path.resolve(', start);
  const frag = readFrag('f_cfg.js');
  s = s.slice(0, start) + frag + s.slice(end);
}

// 4) createAccount: strip in-function quest-claim block; unconditional append
{
  const start = one('  // OPTIONAL post-signup: claim a quest reward (Bedrock-username bypass)');
  const end = one('  return record;', start);
  const frag = readFrag('f_tail.js');
  s = s.slice(0, start) + frag + s.slice(end);
}

// 5) delete the whole claim-cluster (runSingleClaim / claimWithExistingAccount /
//    runClaimOnly) between the createAccount function and the quest helpers
{
  const start = regionStartOfComment(one('// Quest reward claim (with Bedrock-username bypass)'));
  const end = one('async function enrollQuest', start);
  const banner =
    '// --------------------------------------------------------------------------\n' +
    '// Quest + phone verification\n' +
    '// --------------------------------------------------------------------------\n\n';
  s = s.slice(0, start) + banner + s.slice(end);
}

// 6) delete bedrock-list engine (sendDiscordClaimWebhook .. old main) and
//    insert the Java flow + new main in its place
{
  const start = one('async function sendDiscordClaimWebhook');
  const end = one('if (require.main === module) {', start);
  const frag = readFrag('f_flow.js');
  s = s.slice(0, start) + frag + '\n' + s.slice(end);
}

fs.writeFileSync(SRC, s, 'utf8');
console.log('PATCH OK: ' + SRC);
