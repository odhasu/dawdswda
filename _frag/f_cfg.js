    // Java-cookie flow: one Netscape-format Microsoft/Minecraft session cookie
    // .txt per account is dropped into JAVA_COOKIE_DIR (or passed directly via
    // --java-cookie <file-or-dir>). For each cookie the bot creates + phone-
    // verifies ONE Medal account, uploads/posts the clip, then stops — the
    // reward is redeemed in-game as the Java account on DonutSMP, never
    // claimed by the bot.
    javaCookieDir: path.resolve(
      __dirname,
      process.env.JAVA_COOKIE_DIR || 'java_cookies'
    ),
    // Delay between accounts when processing a whole cookie directory (ms).
    javaCookieDelayMs: parseInt(
      process.env.JAVA_COOKIE_DELAY_MS || '3000',
      10
    ),
