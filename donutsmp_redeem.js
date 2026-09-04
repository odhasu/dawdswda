#!/usr/bin/env node
'use strict';
/**
 * CHECKPOINT — DonutSMP in-game /medal redemption (Java Edition).
 *
 * Mints a Minecraft Java SSID from a Microsoft cookie, then hands it to
 * mineflayer (session option, no device-code auth) which handles login,
 * teleport and chat signing. Connects over a SOCKS5 tunnel (same IP as the
 * Medal account), sends /medal and prints the chat response.
 *
 * Usage:
 *   node donutsmp_redeem.js <cookieFile.txt> <socks5://user:pass@host:port>
 */

require('dotenv').config();
const { SocksClient } = require('socks');
const mineflayer = require('mineflayer');
const { mintMinecraftToken } = require('./lib/minecraft_auth');

const HOST = process.env.DONUTSMP_HOST || 'donutsmp.net';
const PORT = Number(process.env.DONUTSMP_PORT || 25565);
const MC_VERSION = process.env.MC_VERSION || '1.21.1';
const REDEEM_CMD = process.env.DONUTSMP_REDEEM_CMD || '/medal';

const [cookieFile, proxyUrl] = process.argv.slice(2);
if (!cookieFile) {
  console.error('usage: node donutsmp_redeem.js <cookieFile.txt> [socks5://user:pass@host:port]');
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
  const minted = await mintMinecraftToken({ cookieFile });
  log(`SSID ok — ${minted.username}`);

  const stream = await openProxyStream(proxyUrl);
  log(`game tunnel socks5 -> ${HOST}:${PORT}${stream ? '' : ' (DIRECT!)'}`);

  const profileId = String(minted.uuid || '').replace(/-/g, '');
  const bot = mineflayer.createBot({
    host: HOST,
    port: PORT,
    username: minted.username,
    version: MC_VERSION,
    ...(stream ? { stream } : {}),
    // Use the pre-minted SSID directly (no device-code auth).
    auth: (client, options) => {
      client.session = {
        accessToken: minted.token,
        selectedProfile: { id: profileId, name: minted.username },
        availableProfiles: [{ id: profileId, name: minted.username }],
      };
      client.username = minted.username;
      client.uuid = profileId;
      if (minted.profileKeys) client.profileKeys = minted.profileKeys;
      options.accessToken = minted.token;
      options.haveCredentials = true;
      setImmediate(() => options.connect(client));
    },
  });

  let settled = false;
  const finish = (code, msg) => {
    if (settled) return;
    settled = true;
    if (msg) log(msg);
    try { bot.quit(); } catch (_) {}
    process.exit(code);
  };
  const timer = setTimeout(() => finish(1, 'timeout'), 60000);

  bot.on('error', (e) => log(`error: ${e.message}`));
  bot.on('end', (r) => finish(0, `disconnected: ${r || 'ok'}`));
  bot.on('kicked', (reason) => log(`KICKED: ${reason}`));

  bot.on('message', (msg) => {
    const text = msg.toString().trim();
    if (text) log(`[chat] ${text}`);
  });

  bot.once('spawn', () => {
    log(`joined ${HOST}`);
    setTimeout(() => {
      log(`sending ${REDEEM_CMD}`);
      bot.chat(REDEEM_CMD);
    }, 2000);
    setTimeout(() => finish(0, 'redeem sent'), 10000);
  });
}

main().catch((e) => {
  console.error('fatal:', e.stack || e.message);
  process.exit(1);
});
