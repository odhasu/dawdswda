  // Java-cookie mode: stamp the record with the cookie metadata so re-runs can
  // skip this account (javaCookieFile is the authoritative "already done" key).
  if (args.javaCookieInfo) {
    record.mode = 'java';
    record.javaCookieFile = args.javaCookieInfo.fileName;
    record.javaIgnHint = args.javaCookieInfo.ignHint;
    record.javaSession = args.javaCookieInfo.sessionLabel;
    record.javaCookieCount = args.javaCookieInfo.cookieCount;
  }

  // Persist. The bot never submits a quest claim here — reward redemption is
  // done in-game by the connected Minecraft account. A fully created + phone-
  // verified account is always useful, so it is appended unconditionally.
  appendAccount(cfg.accountsFile, record);
  vlog(`saved to ${path.basename(cfg.accountsFile)}`);
