#!/usr/bin/env node
'use strict';
/**
 * DonutSMP SOCKS5 relay — connects your Minecraft client to donutsmp.net
 * through a socks5 proxy (same IP as your Medal account).
 *
 *   node relay.js
 *
 * Put your proxy in proxy.txt, then point Minecraft at 127.0.0.1:25566.
 * Uses a manual SOCKS5 handshake (with user/pass auth) so the socket is a
 * clean raw tunnel with no buffering issues.
 */

const net = require('net');
const fs = require('fs');
const path = require('path');

const PROXY_FILE = path.join(__dirname, 'proxy.txt');
const LOCAL_PORT = Number(process.env.LOCAL_PORT || 25566);
const TARGET_HOST = process.env.DONUTSMP_HOST || 'donutsmp.net';
const TARGET_PORT = Number(process.env.DONUTSMP_PORT || 25565);

function readProxy() {
  const raw = fs.readFileSync(PROXY_FILE, 'utf8');
  const line = raw.split(/\r?\n/).map((s) => s.trim()).find((s) => s && !s.startsWith('#'));
  if (!line) throw new Error('proxy.txt is empty — put a socks5://user:pass@host:port line in it');
  return line;
}

function parseSocks5(p) {
  const u = new URL(p);
  if (!u.hostname) throw new Error(`bad proxy URL: ${p}`);
  return {
    host: u.hostname,
    port: Number(u.port || 1080),
    userId: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
  };
}

// Manual SOCKS5 CONNECT (with optional username/password auth). Returns a raw
// socket tunneled to targetHost:targetPort.
function socks5Connect(proxy, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxy.port, proxy.host);
    sock.setNoDelay(true);

    let buf = Buffer.alloc(0);
    const waiters = [];

    function onData(d) {
      buf = Buffer.concat([buf, d]);
      while (waiters.length && buf.length >= waiters[0].n) {
        const w = waiters.shift();
        const result = buf.slice(0, w.n);
        buf = buf.slice(w.n);
        w.resolve(result);
      }
    }
    function read(n) {
      return new Promise((res, rej) => {
        if (buf.length >= n) {
          const result = buf.slice(0, n);
          buf = buf.slice(n);
          res(result);
        } else {
          waiters.push({ n, resolve: res, reject: rej });
        }
      });
    }

    sock.on('data', onData);
    sock.once('error', reject);

    sock.once('connect', async () => {
      try {
        // 1. greeting: socks5, 2 methods (no-auth 0x00, user/pass 0x02)
        sock.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
        const method = (await read(2))[1];
        if (method === 0x02) {
          // 2. username/password auth
          const user = Buffer.from(proxy.userId || '', 'utf8');
          const pass = Buffer.from(proxy.password || '', 'utf8');
          sock.write(Buffer.concat([
            Buffer.from([0x01, user.length]), user,
            Buffer.from([pass.length]), pass,
          ]));
          const authRes = await read(2);
          if (authRes[1] !== 0x00) throw new Error(`socks5 auth failed (code ${authRes[1]})`);
        } else if (method !== 0x00) {
          throw new Error(`socks5 method rejected (${method})`);
        }

        // 3. CONNECT to target (domain address type 0x03)
        const host = Buffer.from(targetHost, 'utf8');
        const port = Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]);
        sock.write(Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
          host,
          port,
        ]));

        // 4. read connect response header
        const hdr = await read(4);
        if (hdr[1] !== 0x00) throw new Error(`socks5 connect failed (rep ${hdr[1]})`);
        const atype = hdr[3];
        if (atype === 0x01) await read(6);          // IPv4 + port
        else if (atype === 0x03) { const l = (await read(1))[0]; await read(l + 2); } // domain + port
        else if (atype === 0x04) await read(18);    // IPv6 + port
        else throw new Error(`bad socks5 address type (${atype})`);

        resolve(sock);
      } catch (e) {
        reject(e);
        sock.destroy();
      }
    });
  });
}

async function main() {
  const proxy = parseSocks5(readProxy());

  const server = net.createServer((localSocket) => {
    localSocket.pause();
    socks5Connect(proxy, TARGET_HOST, TARGET_PORT)
      .then((remote) => {
        localSocket.pipe(remote);
        remote.pipe(localSocket);
        localSocket.on('error', () => {});
        remote.on('error', () => localSocket.destroy());
        localSocket.on('close', () => remote.destroy());
        remote.on('close', () => localSocket.destroy());
        localSocket.resume();
        console.log(`[relay] tunnel opened -> ${TARGET_HOST}:${TARGET_PORT}`);
      })
      .catch((e) => {
        console.error(`[relay] tunnel failed: ${e.message}`);
        localSocket.destroy();
      });
  });

  server.on('error', (e) => {
    console.error(`[relay] server error: ${e.message}`);
    process.exit(1);
  });

  server.listen(LOCAL_PORT, '127.0.0.1', () => {
    console.log(`DonutSMP relay listening on 127.0.0.1:${LOCAL_PORT}`);
    console.log(`proxy: socks5://${proxy.userId || ''}:***@${proxy.host}:${proxy.port}`);
    console.log(`Connect Minecraft (server address) to 127.0.0.1:${LOCAL_PORT} to join DonutSMP via this proxy.`);
  });
}

main().catch((e) => {
  console.error('fatal:', e.message);
  process.exit(1);
});
