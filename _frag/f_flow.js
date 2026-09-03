// --------------------------------------------------------------------------
// Java-cookie flow (one Medal account per Microsoft/Minecraft cookie export)
// --------------------------------------------------------------------------
// The operator connects their own Minecraft Java account: they export the
// signed-in Microsoft session cookie (Netscape format .txt) and drop it into
// JAVA_COOKIE_DIR (or pass --java-cookie <file-or-dir>). For each cookie the
// bot mints ONE Medal account: signup -> phone verify -> clip upload/post,
// then records the cookie against the account and STOPS. The quest reward is
// never claimed here — the operator redeems it in-game as the Java account.

function listJavaCookieFiles(cfg, cliPath) {
  const targets = [];
  const push = (f) => {
    if (/\.(txt|json|bak)$/i.test(f)) targets.push(f);
  };
  if (cliPath) {
    const abs = path.resolve(cliPath);
    if (!fs.existsSync(abs)) {
      throw new Error(`--java-cookie path not found: ${abs}`);
    }
    if (fs.statSync(abs).isDirectory()) {
      for (const f of fs.readdirSync(abs).sort()) push(path.join(abs, f));
    } else {
      push(abs);
    }
  } else {
    if (!fs.existsSync(cfg.javaCookieDir)) {
      throw new Error(
        `java cookie dir not found: ${cfg.javaCookieDir} ` +
          '(drop Netscape .txt cookie exports there, or pass --java-cookie <file-or-dir>)'
      );
    }
    for (const f of fs.readdirSync(cfg.javaCookieDir).sort()) {
      push(path.join(cfg.javaCookieDir, f));
    }
  }
  return targets;
}

function javaCookieFilesDone(cfg) {
  // Cookie stems that already produced a Medal account (mode=java) in an
  // earlier run, so re-runs don't mint a second account for the same cookie.
  const done = new Set();
  for (const rec of loadAccountsFile(cfg.accountsFile)) {
    if (rec && rec.mode === 'java' && rec.javaCookieFile) {
      done.add(rec.javaCookieFile);
    }
  }
  return done;
}

async function javaCookieAccount({ cfg, proxy, info, clipPath, analytics }) {
  const flowArgs = {
    count: 1,
    proxy: null,
    analytics: analytics !== false,
    debugHcaptcha: false,
    captureFile: null,
    verifyPhone: true,
    enrollQuest: true,
    questId: null,
    uploadClip: true,
    clipPath: clipPath || null,
    javaCookieInfo: info,
  };
  return createAccount({ cfg, args: flowArgs, proxy });
}

async function runJavaFlow({ cfg, args, proxies }) {
  const cookieFiles = listJavaCookieFiles(cfg, args.javaCookie);
  if (cookieFiles.length === 0) {
    throw new Error('no java cookie files found');
  }

  // Every account posts the SAME configured clip. Bail early if unset so we
  // don't half-create a directory of accounts before discovering this.
  const clipPath = args.clipPath || cfg.clip.path;
  if (!clipPath || clipPath === '/path/to/minecraft-clip.mp4' || !fs.existsSync(clipPath)) {
    throw new Error(
      'java flow: MEDAL_CLIP_PATH is not set to a real file ' +
        '(set MEDAL_CLIP_PATH in .env or pass --clip-path <file.mp4>)'
    );
  }

  const done = javaCookieFilesDone(cfg);
  const pending = cookieFiles.filter((f) => !done.has(path.basename(f)));
  if (pending.length === 0) {
    log(
      `java flow: all ${cookieFiles.length} cookie file(s) already processed. nothing to do.`
    );
    return { ok: 0, fail: 0, skipped: cookieFiles.length };
  }

  log(
    `java flow: ${cookieFiles.length} cookie file(s), ${pending.length} pending, ` +
      `clip=${clipPath}`
  );

  let ok = 0;
  let fail = 0;
  for (let i = 0; i < pending.length; i++) {
    const filePath = pending[i];
    const base = path.basename(filePath);
    const info = loadJavaCookieInfo(filePath);
    if (!info.ok || !info.usable) {
      fail += 1;
      log(`java flow: SKIP ${base} - ${info.error || info.sessionLabel}`);
      continue;
    }
    log(
      `=== java cookie ${i + 1}/${pending.length}  ${base}  ` +
        `(ign ${info.ignHint})  ${info.sessionLabel} ===`
    );
    const baseProxy = proxies.length
      ? proxies[Math.floor(Math.random() * proxies.length)]
      : null;
    const proxy = rotateProxySessionId(baseProxy);
    try {
      await javaCookieAccount({
        cfg,
        proxy,
        info,
        clipPath,
        analytics: args.analytics,
      });
      ok += 1;
    } catch (e) {
      fail += 1;
      log(`java flow: FAILED ${base}: ${e.message}`);
    }
    if (i < pending.length - 1) {
      const wait = cfg.javaCookieDelayMs + Math.floor(Math.random() * 1000);
      await new Promise((res) => setTimeout(res, wait));
    }
  }
  log(`java flow done. ok=${ok} fail=${fail} skipped=${cookieFiles.length - pending.length}`);
  return { ok, fail, skipped: cookieFiles.length - pending.length };
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv);

  // Verbose mode: --verbose CLI flag OR MEDAL_VERBOSE=1 env. When OFF (default)
  // we suppress the chatty per-step "ok" logs and keep only milestones,
  // retries, warnings, and errors. Routine failures still throw, so muting
  // the success spam doesn't hide real problems.
  if (args.verbose || /^(1|true|yes)$/i.test(process.env.MEDAL_VERBOSE || '')) {
    setVerboseLogging(true);
  }

  if (args.debugHcaptcha) {
    const defaultCaptureCandidates = [
      args.captureFile ? path.resolve(args.captureFile) : null,
      path.resolve('/root/httprequest.txt'),
      path.resolve(__dirname, '../httprequest.txt'),
      path.resolve(__dirname, 'httprequest.txt'),
    ]
      .filter(Boolean)
      .filter((p, idx, arr) => arr.indexOf(p) === idx);
    const ok = debugHcaptchaFromFiles(defaultCaptureCandidates);
    process.exit(ok ? 0 : 2);
  }

  const javaMode = !!args.javaCookie;
  const cfg = loadConfig({ requirePhone: args.verifyPhone || javaMode });
  if (args.questId) cfg.questId = args.questId;

  const proxies = args.proxy
    ? [normalizeProxy(args.proxy)]
    : loadProxiesFile(cfg.proxiesFile);

  if (proxies.length === 0) {
    log('no proxies configured - using direct connection');
  } else {
    log(`loaded ${proxies.length} proxy(ies) from ${path.basename(cfg.proxiesFile)}`);
    describeProxyMode(proxies, log);
  }

  // Java-cookie mode: one Medal account per uploaded Microsoft/Minecraft
  // session cookie (.txt). Signup -> phone verify -> clip upload/post -> STOP.
  if (javaMode) {
    try {
      const res = await runJavaFlow({ cfg, args, proxies });
      process.exit(res.fail > 0 && res.ok === 0 ? 1 : 0);
    } catch (e) {
      log(`java flow FAILED: ${e.stack || e.message}`);
      process.exit(1);
    }
  }

  // Legacy single-account loop: --count N fresh signups (optionally phone-
  // verified + clip posted via --verify-phone / --upload-clip). No claim.
  let ok = 0;
  let fail = 0;

  for (let i = 0; i < args.count; i++) {
    const baseProxy = proxies.length
      ? proxies[Math.floor(Math.random() * proxies.length)]
      : null;
    const proxy = rotateProxySessionId(baseProxy);
    log(`=== account ${i + 1}/${args.count} ===`);
    try {
      await createAccount({ cfg, args, proxy });
      ok += 1;
    } catch (e) {
      fail += 1;
      log(`FAILED: ${e.message}`);
    }
    // small jitter between accounts
    if (i < args.count - 1) {
      const wait = 1500 + Math.floor(Math.random() * 2500);
      await new Promise((res) => setTimeout(res, wait));
    }
  }

  log(`done. ok=${ok} fail=${fail}`);
  process.exit(fail > 0 && ok === 0 ? 1 : 0);
}
