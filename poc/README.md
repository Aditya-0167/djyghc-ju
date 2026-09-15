# PoC: @google/gemini-cli-sdk insecure-by-default policy

Demonstrates that `PolicyEngine`, constructed with the exact
`policyEngineConfig` object `packages/sdk/src/session.ts` uses for every
`GeminiCliSession`, silently allows a `write_file` tool call that matches
no configured rule — with a control test showing the engine's own
built-in default (no override at all) is `ASK_USER`, isolating that this
is the SDK's deliberate choice, not an engine-level gap.

## Run it yourself

```bash
git clone https://github.com/google-gemini/gemini-cli.git
cd gemini-cli
git checkout 9c1b0a610534d6f8120964cf2672c07807d8fc90

npm ci
npm run build --workspace @google/gemini-cli-core

cp sdk-default-allow.security-repro.test.ts packages/cli/src/config/extensions/
cd packages/cli
npx vitest run src/config/extensions/sdk-default-allow.security-repro.test.ts --reporter=verbose
```

Expected (vulnerable) result: both tests pass — the `write_file` call
resolves to `ALLOW` with no rule matched, and the control confirms the
engine's own unconfigured default is `ASK_USER`.

See `captured-output.txt` for a full run, and
`../.github/workflows/verify-poc.yml` for an independently-runnable CI
version of the same steps.
