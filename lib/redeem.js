'use strict';
/**
 * DonutSMP /medal redemption helper. Reused by the CLI (donutsmp_redeem.js)
 * and by medal_signup.js's auto-chain after a quest claim.
 *
 * redeemMedal(cookieFile, proxy) mints the SSID, joins donutsmp.net over the
 * SOCKS5 proxy and sends /medal, resolving { success, shards } once the chat
 * confirms the reward (or the bot is kicked / times out).
 */

const { SocksClient } = require('socks');
const mineflayer = require('mineflayer');
const { mintMinecraftToken } = require('./minecraft_auth');

const HOST = process.env.DONUTSMP_HOST || 'donutsmp.net';
const PORT = Number(process.env.DONUTSMP_PORT || 25565);
const MC_VERSION = process.env.MC_VERSION || '1.21.1';
const REDEEM_CMD = process.env.DONUTSMP_REDEEM_CMD || '/medal';
const REDEEM_TIMEOUT_MS = Number(process.env.DONUTSMP_REDEEM_TIMEOUT_MS || 30000);

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

async function redeemMedal(cookieFile, proxy) {
  const minted = await mintMinecraftToken({ cookieFile });
  log(`  [redeem] SSID ok — ${minted.username}`);

  const stream = await openProxyStream(proxy);
  const profileId = String(minted.uuid || '').replace(/-/g, '');

  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      try { bot.quit(); } catch (_) {}
      resolve(result);
    };
    const timer = setTimeout(() => done({ success: false, error: 'redeem timeout' }), REDEEM_TIMEOUT_MS);

    const bot = mineflayer.createBot({
      host: HOST,
      port: PORT,
      username: minted.username,
      version: MC_VERSION,
      ...(stream ? { stream } : {}),
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

    bot.on('error', (e) => log(`  [redeem] error: ${e.message}`));
    bot.on('kicked', (r) => { log(`  [redeem] kicked: ${r}`); done({ success: false, error: 'kicked: ' + r }); });
    bot.on('end', (r) => { if (!settled) done({ success: false, error: 'disconnected: ' + (r || 'ok') }); });

    bot.on('message', (msg) => {
      const text = msg.toString();
      if (/shard|medal|reward/i.test(text)) log(`  [redeem] chat: ${text.trim()}`);
      // The reward confirmation ("You received 5K Shards!") means success.
      if (/received .*shard/i.test(text)) {
        const m = text.match(/([\d,.]+[kKmM]?)\s*shard/i);
        done({ success: true, shards: m ? m[1] : '?', message: text.trim() });
      }
    });

    bot.once('spawn', () => {
      log(`  [redeem] joined ${HOST}`);
      setTimeout(() => {
        log(`  [redeem] sending ${REDEEM_CMD}`);
        bot.chat(REDEEM_CMD);
      }, 1500);
    });
  });
}

module.exports = { redeemMedal };
