#!/usr/bin/env node
'use strict';
/**
 * CHECKPOINT — DonutSMP in-game /medal redemption.
 *
 * Joins donutsmp.net (Minecraft Java Edition) through a SOCKS5 proxy so the
 * login egresses from the SAME upstream IP the Medal account used, sends
 * /medal to redeem the 5000 shards, waits for the confirmation message, then
 * disconnects.
 *
 * NOTE: Minecraft speaks raw TCP, so this REQUIRES a SOCKS5 proxy. HTTP
 * residential proxies (res.proxy-seller.com) cannot carry the game connection.
 *
 * Usage:
 *   npm i mineflayer socks
 *   node donutsmp_redeem.js <minecraftUsername> [socks5://user:pass@host:port]
 *
 * Auth: first run does the Microsoft device-code flow (or browser) and caches
 * the token for subsequent runs. See mineflayer `auth: 'microsoft'`.
 */

require('dotenv').config();
const { SocksClient } = require('socks');
const mineflayer = require('mineflayer');

const HOST = process.env.DONUTSMP_HOST || 'donutsmp.net';
const PORT = Number(process.env.DONUTSMP_PORT || 25565);
const REDEEM_CMD = process.env.DONUTSMP_REDEEM_CMD || '/medal';
const REDEEM_TIMEOUT_MS = Number(process.env.DONUTSMP_REDEEM_TIMEOUT_MS || 120000);

const [username, proxyUrl] = process.argv.slice(2);
if (!username) {
  console.error('usage: node donutsmp_redeem.js <minecraftUsername> [socks5://user:pass@host:port]');
  process.exit(1);
}

function log(m) {
  console.log(`[${new Date().toISOString()}] ${m}`);
}

function parseSocks5(p) {
  if (!p) return null;
  try {
    const u = new URL(p);
    if (!u.hostname) return null;
    return {
      host: u.hostname,
      port: Number(u.port || 1080),
      userId: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
    };
  } catch (_) {
    return null;
  }
}

async function openProxyStream(proxy) {
  const s = parseSocks5(proxy);
  if (!s) return undefined;
  const conn = await SocksClient.createConnection({
    proxy: { host: s.host, port: s.port, type: 5, userId: s.userId, password: s.password },
    command: 'connect',
    destination: { host: HOST, port: PORT },
  });
  return conn.socket;
}

async function main() {
  const stream = await openProxyStream(proxyUrl);
  log(`connecting to ${HOST}:${PORT} as ${username}${stream ? ' (via socks5)' : ' (direct — IP mismatch risk!)'}`);

  const bot = mineflayer.createBot({
    username,
    auth: 'microsoft',
    host: HOST,
    port: PORT,
    ...(stream ? { stream } : {}),
    checkTimeoutInterval: 30000,
  });

  let settled = false;
  const finish = (code, msg) => {
    if (settled) return;
    settled = true;
    if (msg) log(msg);
    try { bot.quit(); } catch (_) {}
    process.exit(code);
  };
  const timer = setTimeout(() => finish(1, `timeout after ${REDEEM_TIMEOUT_MS}ms — no redemption confirmation`), REDEEM_TIMEOUT_MS);

  bot.once('spawn', () => {
    log(`spawned as ${bot.username}; sending ${REDEEM_CMD} in 3s`);
    setTimeout(() => bot.chat(REDEEM_CMD), 3000);
  });

  bot.on('message', (msg) => {
    const text = msg.toString();
    if (/medal|shard|reward|claim|redemption|5000/i.test(text)) log(`[chat] ${text}`);
  });

  bot.on('kicked', (reason) => finish(1, `kicked: ${reason}`));
  bot.on('error', (e) => finish(1, `error: ${e.message}`));
  bot.on('end', (reason) => finish(0, `disconnected: ${reason}`));
}

main().catch((e) => {
  console.error('fatal:', e.stack || e.message);
  process.exit(1);
});
