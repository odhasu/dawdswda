'use strict';

/**
 * Thin 5sim.net API client.
 *
 * Docs: https://5sim.net/docs
 *
 * Flow we use for Medal:
 *   1. buyActivation()        GET /v1/user/buy/activation/england/any/medal
 *      -> { id, phone, status: 'PENDING', ... }
 *   2. waitForCode(id)        polls GET /v1/user/check/{id} until SMS arrives
 *      -> { code, sms, order }
 *   3. finishOrder(id)        GET /v1/user/finish/{id}  (after successful verify)
 *   -- or --
 *      cancelOrder(id)        GET /v1/user/cancel/{id}  (no SMS used yet)
 *      banOrder(id)           GET /v1/user/ban/{id}     (number leaked / bad)
 */

const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

const DEFAULT_BASE = 'https://5sim.net/v1';

function buildProxyAgent(proxy) {
  if (!proxy) return null;
  if (typeof proxy !== 'string') return proxy; // already an agent instance
  if (proxy.startsWith('socks')) return new SocksProxyAgent(proxy);
  return new HttpsProxyAgent(proxy);
}

class FiveSim {
  constructor({
    apiKey,
    base = DEFAULT_BASE,
    country = 'england',
    operator = 'any',
    product = 'medal',
    timeout = 30_000,
    // Optional outbound proxy (string URL like "http://user:pass@host:port"
    // or "socks5://..."). When set, ALL 5sim API calls tunnel through it.
    // This is what lets us spread /user/buy/activation calls across many
    // upstream IPs so 5sim's per-IP rate limiter doesn't 429 us into the
    // ground when running 100s of concurrent workers.
    proxy = null,
  } = {}) {
    if (!apiKey) throw new Error('FiveSim: apiKey is required');
    this.apiKey = apiKey;
    this.base = base.replace(/\/$/, '');
    this.country = country;
    this.operator = operator;
    this.product = product;
    this.proxy = proxy || null;
    const agent = buildProxyAgent(this.proxy);
    this.http = axios.create({
      timeout,
      validateStatus: () => true,
      httpAgent: agent,
      httpsAgent: agent,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    });
  }

  async _get(path) {
    const url = `${this.base}${path}`;
    const r = await this.http.get(url);
    if (r.status >= 400) {
      const body =
        typeof r.data === 'string'
          ? r.data.slice(0, 300)
          : JSON.stringify(r.data).slice(0, 300);
      throw new Error(`5sim GET ${path} -> ${r.status}: ${body}`);
    }
    return r.data;
  }

  profile() {
    return this._get('/user/profile');
  }

  /**
   * Guest endpoint: list operators that sell <product> for <country>, with
   * live stock count, success rate, and cost. No auth required (the bearer
   * token is harmless on guest endpoints, 5sim ignores it).
   *
   * Response shape:
   *   { [country]: { [product]: { [operator]: {
   *       cost: number,    // price in account currency
   *       count: number,   // current stock
   *       rate: number,    // success rate %, all-time
   *       rate1, rate3, rate24, rate72, rate168, rate720  // recent windows
   *   }}}}
   *
   * Some operators show up with `count: 0` or no `rate` field — callers
   * should filter those out.
   */
  prices({ country, product } = {}) {
    const c = encodeURIComponent(country || this.country);
    const p = encodeURIComponent(product || this.product);
    return this._get(`/guest/prices?country=${c}&product=${p}`);
  }

  /**
   * Buy an activation (short-term) number.
   * Returns { id, phone, operator, product, price, status, expires, sms, ... }
   */
  buyActivation({ country, operator, product } = {}) {
    const c = encodeURIComponent(country || this.country);
    const o = encodeURIComponent(operator || this.operator);
    const p = encodeURIComponent(product || this.product);
    return this._get(`/user/buy/activation/${c}/${o}/${p}`);
  }

  checkOrder(id) {
    return this._get(`/user/check/${id}`);
  }

  finishOrder(id) {
    return this._get(`/user/finish/${id}`);
  }

  cancelOrder(id) {
    return this._get(`/user/cancel/${id}`);
  }

  banOrder(id) {
    return this._get(`/user/ban/${id}`);
  }

  /**
   * Poll /user/check/{id} until an SMS arrives or we give up.
   * Returns { code, sms, order } where:
   *   code  = extracted one-time code (string)
   *   sms   = the first sms object {sender, text, code, ...}
   *   order = full order record at the time the code showed up
   */
  async waitForCode(
    id,
    { timeoutMs = 5 * 60 * 1000, intervalMs = 5_000, onPoll } = {}
  ) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let info;
      try {
        info = await this.checkOrder(id);
      } catch (e) {
        // transient errors -> retry after interval
        if (onPoll) onPoll({ error: e.message });
        await sleep(intervalMs);
        continue;
      }

      if (onPoll) {
        onPoll({
          status: info?.status,
          smsCount: Array.isArray(info?.sms) ? info.sms.length : 0,
        });
      }

      if (Array.isArray(info?.sms) && info.sms.length > 0) {
        const first = info.sms[0];
        const code = first.code || extractCode(first.text);
        if (code) return { code, sms: first, order: info };
      }

      // Terminal states -> no point in waiting
      if (['CANCELED', 'TIMEOUT', 'BANNED', 'FINISHED'].includes(info?.status)) {
        throw new Error(
          `5sim order ${id} ended in state ${info.status} before an SMS arrived`
        );
      }

      await sleep(intervalMs);
    }
    throw new Error(`Timed out (${timeoutMs}ms) waiting for SMS on 5sim order ${id}`);
  }
}

function extractCode(text) {
  if (!text || typeof text !== 'string') return null;
  // 4-8 digit code is the most common SMS format
  const m = text.match(/\b(\d{4,8})\b/);
  return m ? m[1] : null;
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

module.exports = { FiveSim };
