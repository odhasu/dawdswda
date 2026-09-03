# Disclaimer

This project is intended for educational and ethical cybersecurity research only. Any use of this software on systems, services, or individuals without explicit permission is strictly prohibited and may be illegal. It is the end user's responsibility to comply with all applicable laws and platform policies. The authors assume no liability for any misuse or consequences.


# Medalbot

Automated [Medal.tv](https://medal.tv) account creation and quest completion. Replays the Medal-Electron signup HTTP flow, solves hCaptcha through configurable providers, and runs a quest pipeline:

| Pipeline | Script | Reward |
| --- | --- | --- |
| **DonutSMP Skeleton Spawner** | `medal_signup.js` (Java-cookie mode) | Skeleton spawners on DonutSMP (Minecraft Java) |

Designed to work alongside another VPS project:

- **`/root/afk`** — separate Minecraft bot farm used to redeem rewards in-game on DonutSMP (Java accounts)

---

## Contents

- [Architecture](#architecture)
- [DonutSMP Skeleton Spawner Quest](#donutsmp-skeleton-spawner-quest)
- [Integration with /root/afk](#integration-with-rootafk)
- [Entry points](#entry-points)
- [Install](#install)
- [Configuration](#configuration)
- [medal_signup.js](#medal_signupjs)
- [lib/ modules](#lib-modules)
- [PM2 deployment](#pm2-deployment)
- [Output files](#output-files)
- [Troubleshooting](#troubleshooting)

---

## Architecture

medalbot runs off a single upstream pool:

1. **Java cookies (yours)** → `medal_signup.js`. For each Netscape-format Microsoft/Minecraft session cookie: **signup → 5sim phone verify → clip upload/post → STOP** (never claims). You redeem the DonutSMP reward in-game as that Java account — manually, or via `/root/afk` bots.

| Component | Role |
| --- | --- |
| **`/root/afk`** | Separate Minecraft bot farm that redeems `/medal` rewards in-game on DonutSMP |
| **medal_signup.js** | Medal signup + DonutSMP **skeleton spawner** quest (Java-cookie mode: signup → phone verify → clip/post → stop) |

---

## DonutSMP Skeleton Spawner Quest

Medal quest **`2pQLGqBjtd`** (DonutSMP skeleton spawner). This is medalbot's Minecraft **Java Edition** pipeline.

### How it works

The reward is earned by a Minecraft **Java Edition** account you already own. medalbot never handles the reward — it only mints a phone-verified Medal account per uploaded Java session cookie and posts your clip so the quest task is satisfied. Redemption is done in-game by you.

For each uploaded Java cookie (`.txt`), medalbot:

1. Creates a fresh Medal account (hCaptcha + 5sim phone verify)
2. Enrolls quest `2pQLGqBjtd` (non-fatal)
3. Uploads + posts your Minecraft clip to the Medal profile (PUBLIC)
4. Records the cookie against the account, then **stops** — no quest claim is ever submitted

After the run, log into DonutSMP as the Java account and redeem the reward in-game.

### Java-cookie mode (default)

You connect your Minecraft Java account yourself: sign into the Microsoft/Minecraft account in a browser, export the session as a **Netscape-format cookie `.txt`** (like a cookie-editor export), and drop it into `java_cookies/` — or point at it directly.

```bash
node medal_signup.js --java-cookie ./java_cookies                        # whole dir
node medal_signup.js --java-cookie ./java_cookies/ravanwashere33g.txt    # one cookie
```

Per cookie the bot runs **signup → phone verify → clip upload/post → STOP**. Re-runs skip cookies that already produced an account (records with `"mode":"java"` in `accounts.jsonl`).

### Quest config

```
MEDAL_QUEST_ID=2pQLGqBjtd
MEDAL_CLIP_PATH=/path/to/minecraft-clip.mp4          # must be a real file
MEDAL_CLIP_CATEGORY_ID=hAXdelx2t                     # Minecraft
JAVA_COOKIE_DIR=java_cookies
JAVA_COOKIE_DELAY_MS=3000
```

---

## Integration with /root/afk

`medal_signup.js` uses the **Java-cookie flow** above — one Medal account per Microsoft/Minecraft session cookie. `/root/afk` is a separate Minecraft bot farm you can still use to redeem the quest reward **in-game** on DonutSMP once the Medal account is linked to your Java account.

### Typical end-to-end run

```bash
# 1. Sign up + phone-verify one Medal account per Java cookie, post your clip
cd /root/medalbot
node medal_signup.js --java-cookie ./java_cookies

# 2. Redeem the reward in-game on DonutSMP as the Java account (e.g. /medal)
#    — manually, or via /root/afk if you drive bot accounts there
```

---

## Entry points

| Script | Quest / mode |
| --- | --- |
| `medal_signup.js` | DonutSMP **skeleton spawner** (Java-cookie mode), single/batch signup |
| `cleanup_accounts_jsonl.js` | Utility: prune `accounts.jsonl` to successful claims only |

```bash
npm start                    # alias for node medal_signup.js
node medal_signup.js -h
```

---

## Install

```bash
cd /root/medalbot
npm install
cp .env.example .env
# Edit .env — MEDAL_HCAPTCHA_SITEKEY, EMAIL_DOMAIN, captcha API key, FIVESIM_API_KEY
# Create proxies.txt (one proxy per line)
# Drop one Netscape-format Microsoft/Minecraft cookie .txt per Java account
# into java_cookies/ for medal_signup.js Java-cookie mode
```

**Requirements:** Node.js ≥ 18, npm, residential proxies (strongly recommended).

---

## Configuration

All scripts load `.env` via `dotenv`. See `.env.example` for the full variable list.

### Captcha providers

Set `CAPTCHA_PROVIDER` explicitly, or auto-pick the first configured key:

| Provider | Env var |
| --- | --- |
| OnyxSolver | `ONYX_API_KEY` |
| NopeCHA | `NOPECHA_API_KEY` |
| VoidSolver | `VOIDSOLVER_API_KEY` |
| RezoSolver | `REZOSOLVER_API_KEY` |
| Capless | `CAPLESS_API_KEY` |
| Manual (Chromium) | `CAPTCHA_PROVIDER=manual` — no key. Opens a visible Chromium window with the hCaptcha widget; you click the checkbox / solve the puzzle, and the token is captured for the signup. Must be solved from the same IP the signup egresses from. |

### DonutSMP / Java-cookie

```
MEDAL_QUEST_ID=2pQLGqBjtd
MEDAL_CLIP_PATH=/path/to/minecraft-clip.mp4
MEDAL_CLIP_CATEGORY_ID=hAXdelx2t
JAVA_COOKIE_DIR=java_cookies
JAVA_COOKIE_DELAY_MS=3000
```

### Phone verification (5sim.net)

Required for Java-cookie mode:

```
FIVESIM_API_KEY=...
FIVESIM_COUNTRY=england
FIVESIM_PRODUCT=medal
```

---

## medal_signup.js

Replays the Medal-Electron signup HTTP sequence and supports two operating modes:

1. **Java-cookie mode** — `--java-cookie <file-or-dir>`: one Medal account per Microsoft/Minecraft cookie export. signup → 5sim phone verify → clip upload/post → **STOP** (never claims).
2. **Single / batch signup** — `--count N`, optional `--verify-phone`, `--upload-clip`.

### Usage

```bash
node medal_signup.js --java-cookie ./java_cookies                 # Java-cookie mode (whole dir)
node medal_signup.js --java-cookie ./java_cookies/acct.txt        # single cookie
node medal_signup.js --count 10                                   # batch fresh signups
node medal_signup.js --verify-phone --upload-clip                 # signup + phone verify + clip
```

### Clip upload

Medal's GCS resumable upload flow. Required for the DonutSMP quest task "Post your clip to your Medal profile".

---

## lib/ modules

| Module | Role |
| --- | --- |
| `lib/medal_referral.js` | Referral username lookup + apply |
| `lib/sms5sim.js` | 5sim.net phone verification client |

---

## PM2 deployment

DonutSMP (Java-cookie) runs are started manually or via a PM2 entry pointing at `medal_signup.js --java-cookie ./java_cookies`.

---

## Output files

All runtime output is **gitignored**:

| File | Used by |
| --- | --- |
| `accounts.jsonl` | Medal accounts — Java mode marks records `"mode":"java"` + cookie file so re-runs skip already-done cookies |
| `failed-accounts.jsonl` | Partial signups that can be retried |

---

## Troubleshooting

### DonutSMP / Java-cookie

| Symptom | Fix |
| --- | --- |
| `java cookie dir not found` | Create `java_cookies/`, or pass `--java-cookie <file-or-dir>` |
| Cookie `.txt` skipped (`not usable`) | Re-export the Microsoft/Minecraft session as a Netscape cookie file that includes the MSA auth cookies |
| `MEDAL_CLIP_PATH is not set to a real file` | Point `MEDAL_CLIP_PATH` (or `--clip-path`) at a real clip file |
| `/medal` gives nothing in-game | Medal account must be linked to the Java account and the clip must be posted PUBLIC |
| 5sim `no free phones` | Raise `FIVESIM_PHONE_RETRIES` or switch `FIVESIM_COUNTRY` / operator list |

### Medal signup

| Symptom | Fix |
| --- | --- |
| `403` on signup | Wrong hCaptcha sitekey |
| `429` rate limit | Add proxies and spread requests (e.g. `JAVA_COOKIE_DELAY_MS`) |
| `errorId:37` phone blocked | Different 5sim operator; match proxy geo to number country |

---

## Getting the hCaptcha sitekey

Intercept Medal-Electron signup traffic (HTTP Toolkit) and find `sitekey=` on an `hcaptcha.com` request, or extract `app.asar` from the Electron bundle and grep for `sitekey`.

Paste into `MEDAL_HCAPTCHA_SITEKEY` in `.env`.

---

## License

Private tooling. For educational and authorized testing use only. Automated account creation and quest farming may violate Medal.tv and DonutSMP Terms of Service.
