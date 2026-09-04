#!/usr/bin/env node
'use strict';
/**
 * DonutSMP /medal redemption (CLI). Mints the SSID from a cookie, joins
 * donutsmp.net over SOCKS5, sends /medal, and on success moves the cookie to
 * redeemed_java_cookies/.
 *
 * Usage:
 *   node donutsmp_redeem.js <cookieFile.txt> <socks5://user:pass@host:port>
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { redeemMedal } = require('./lib/redeem');

const [cookieFile, proxyUrl] = process.argv.slice(2);
if (!cookieFile) {
  console.error('usage: node donutsmp_redeem.js <cookieFile.txt> [socks5://user:pass@host:port]');
  process.exit(1);
}

const REDEEMED_DIR = path.resolve(__dirname, process.env.JAVA_REDEEMED_COOKIES_DIR || 'redeemed_java_cookies');

async function main() {
  const res = await redeemMedal(cookieFile, proxyUrl);
  if (res.success) {
    console.log(`[redeem] SUCCESS: ${res.shards || 'shards'} — moving cookie to redeemed/`);
    try {
      fs.mkdirSync(REDEEMED_DIR, { recursive: true });
      const src = path.resolve(cookieFile);
      const dst = path.join(REDEEMED_DIR, path.basename(cookieFile));
      if (fs.existsSync(src)) fs.renameSync(src, dst);
      console.log(`[redeem] moved -> ${dst}`);
    } catch (e) {
      console.log(`[redeem] could not move cookie: ${e.message}`);
    }
    process.exit(0);
  } else {
    console.log(`[redeem] FAILED: ${res.error || 'unknown'}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('fatal:', e.stack || e.message);
  process.exit(1);
});
