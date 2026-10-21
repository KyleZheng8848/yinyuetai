# Contributing

Use Node.js 22 LTS (>=22.14) and the committed npm lockfile. Start from a clean checkout and run:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run check:version
```

These checks use deterministic Demo synthesis, temporary runtime directories and local mock servers. They do not install model weights or require model/cloud credentials. Generated test audio in `outputs/` is ignored. `tools/test-ace-e2e.js` requires a separately installed real model and is an optional manual check; browser/Electron UI scripts are also separate from this default source suite.

Use normal `npm ci` for desktop development so Electron is downloaded. Run `npm start`, or use `npm run web` for the loopback web UI. Keep runtime data, model downloads, API credentials, reference audio, generated audio, caches and installers out of Git. Update both READMEs when setup or user-facing behavior changes, and preserve the SofunAI Studio publisher mark and repository/Releases links.

For an application version change, update `package.json`, both root versions in `package-lock.json`, the first `CHANGELOG.md` entry and cache-version query strings in `index.html`, then run `check:version`. A README-only change does not require an app version bump. See [the release guide](docs/RELEASING.md).

Check the license for new dependencies and model integrations. Original project code is MIT; retain third-party notices and do not bundle models or music without permission. Report reproducible bugs at https://github.com/KyleZheng8848/yinyuetai/issues with redacted logs. Do not attach API keys, provider configuration, reference audio or personal libraries to public issues.
