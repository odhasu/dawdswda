// --------------------------------------------------------------------------
// CLI args
// --------------------------------------------------------------------------
function parseArgs(argv) {
  const args = {
    count: 1,
    proxy: null,
    analytics: true,
    debugHcaptcha: false,
    captureFile: null,
    verifyPhone: false,
    enrollQuest: true,
    questId: null,
    uploadClip: false,
    clipPath: null,
    verbose: false,
    javaCookie: null, // path to ONE Microsoft/Minecraft cookie .txt OR a directory
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--count' || a === '-n') {
      args.count = parseInt(argv[++i], 10) || 1;
    } else if (a === '--proxy' || a === '-p') {
      args.proxy = argv[++i];
    } else if (a === '--no-analytics') {
      args.analytics = false;
    } else if (a === '--debug-hcaptcha') {
      args.debugHcaptcha = true;
    } else if (a === '--capture-file') {
      args.captureFile = argv[++i];
    } else if (a === '--verify-phone') {
      args.verifyPhone = true;
    } else if (a === '--no-verify-phone') {
      args.verifyPhone = false;
    } else if (a === '--no-enroll-quest') {
      args.enrollQuest = false;
    } else if (a === '--quest-id') {
      args.questId = argv[++i];
    } else if (a === '--upload-clip') {
      args.uploadClip = true;
    } else if (a === '--clip-path') {
      args.clipPath = argv[++i];
      args.uploadClip = true;
    } else if (a === '--java-cookie' || a === '-j') {
      args.javaCookie = argv[++i];
    } else if (a === '--verbose' || a === '-v') {
      args.verbose = true;
    } else if (a === '-h' || a === '--help') {
      console.log(
        'Usage: node medal_signup.js [options]\n' +
          '\n' +
          'Java-cookie mode (one Medal account per Microsoft/Minecraft cookie):\n' +
          '  --java-cookie <file-or-dir>   a Netscape-format cookie .txt for one Java\n' +
          '                                 account, or a directory of them. For each\n' +
          '                                 cookie the bot: signup -> phone verify ->\n' +
          '                                 clip upload/post -> STOP. It never submits a\n' +
          '                                 quest claim; you redeem the reward in-game.\n' +
          '                                 Default cookie dir: ./java_cookies\n' +
          '\n' +
          'Generic options:\n' +
          '  --count N                     create N accounts in a loop (default 1)\n' +
          '  --proxy user:pass@host:port   tunnel requests through this proxy\n' +
          '  --verify-phone                verify the phone via 5sim.net (FIVESIM_API_KEY)\n' +
          '  --no-enroll-quest             skip quest enrollment after signup\n' +
          '  --quest-id <id>               override quest enrollment target\n' +
          '  --upload-clip / --clip-path <file>\n' +
          '                                 upload + post a clip (posts PUBLIC to profile)\n' +
          '  --no-analytics                skip amplitude/firestore analytics calls\n' +
          '  --debug-hcaptcha              debug hCaptcha from capture files\n' +
          '  --capture-file <path>         capture log path (debug mode)\n' +
          '  --verbose|-v                  chatty per-step logging\n' +
          '  --help|-h                     show this help\n'
      );
      process.exit(0);
    }
  }
  return args;
}
