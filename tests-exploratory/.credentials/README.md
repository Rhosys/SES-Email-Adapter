# Credential Cache

This directory caches IMAP credentials used by the exploratory tests (`npm run test:exploratory`).

Credentials are stored as plaintext JSON and gitignored. On each run, the global setup prompts whether to clear the cache or reuse existing credentials.

Never commit actual credential files here — only this README and the .gitignore are tracked.
