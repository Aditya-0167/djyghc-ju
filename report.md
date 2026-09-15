# @google/gemini-cli-sdk ships an insecure-by-default policy config — every tool call an SDK-based agent makes that isn't explicitly ruled is silently auto-approved, with no public API to change it

**Program:** Google Cloud VRP (`google-gemini/gemini-cli` is `SCOPE_CLOUD_VRP` / `TIER_OT1` per
`google/bughunters` `oss-repository-tier/external_repositories.txtpb`)
**Repo / component:** `google-gemini/gemini-cli`, `packages/sdk` (published to npm as `@google/gemini-cli-sdk`)
**Verified against commit:** `9c1b0a610534d6f8120964cf2672c07807d8fc90`
**Class:** Insecure default configuration — missing authorization / consent gate, broadly scoped (affects every application built on this SDK, not one code path)
**Reporter note on severity:** not asserting a tier or bounty amount. This one is different in kind from other findings I've sent — narrower per-instance precondition than a network exploit, but the blast radius is "every application built on this published SDK," which I think is worth weighing on its own terms. Laid out honestly below.

## Summary

`packages/sdk/src/session.ts` builds every `GeminiCliSession`'s underlying `Config` with:

```js
policyEngineConfig: {
  // TODO: Revisit this default when we have a mechanism for wiring up approvals
  defaultDecision: PolicyDecision.ALLOW,
},
```

`defaultDecision` is what `PolicyEngine` falls back to whenever a tool call doesn't match any configured rule. `PolicyEngine`'s own constructor shows what the engine itself considers a safe default when nothing is specified:

```js
this.defaultDecision =
  config.defaultDecision ??
  (this.nonInteractive ? PolicyDecision.DENY : PolicyDecision.ASK_USER);
```

So the SDK isn't just missing a safe default — it's actively overriding the engine's own "ask the user" / "deny" default with "allow everything," and the comment right above it says this is a known, temporary stopgap ("when we have a mechanism for wiring up approvals" — i.e., there currently isn't one).

I checked `GeminiCliAgentOptions` (`packages/sdk/src/types.ts`), the entire public configuration surface for the SDK — there is no field anywhere to override `policyEngineConfig`/`defaultDecision`. A developer using the documented, public API has no way to change this. The SDK's own `README.md` quick-start example — `new GeminiCliAgent({ instructions: 'You are a helpful assistant.' })` — is exactly this insecure configuration, with zero mention of policy, approval, or security anywhere in the README.

## Root cause, with exact unmodified code

**`packages/sdk/src/session.ts` (constructor, lines ~74–95):**
```js
const configParams: ConfigParameters = {
  sessionId: this.sessionId,
  targetDir: cwd,
  cwd,
  debugMode: options.debug ?? false,
  model: options.model || PREVIEW_GEMINI_MODEL_AUTO,
  userMemory: initialMemory,
  // Minimal config
  enableHooks: false,
  mcpEnabled: false,
  extensionsEnabled: false,
  recordResponses: options.recordResponses,
  fakeResponses: options.fakeResponses,
  skillsSupport: true,
  adminSkillsEnabled: true,
  policyEngineConfig: {
    // TODO: Revisit this default when we have a mechanism for wiring up approvals
    defaultDecision: PolicyDecision.ALLOW,
  },
};

this.config = new Config(configParams);
```
`enableHooks: false` and `mcpEnabled: false` do reduce some risk (the extension-hooks and MCP-server-command-execution surfaces are off), but they don't touch the core tool set: file read/write/edit, and any custom `Tool` the developer registers via `options.tools` (which is the SDK's entire reason to exist — `tools?: Array<Tool<any>>` is a first-class, documented option). The SDK also ships its own convenience wrapper for the shell tool (`packages/sdk/src/shell.ts`, wiring up the real `ShellTool`), so shell execution is a natural, easy addition for a developer building on this SDK, not a hypothetical.

**`packages/core/src/policy/policy-engine.ts` — how `defaultDecision` actually gets used when no rule matches (lines ~735–773):**
```js
if (decision === undefined) {
  if (this.approvalMode === ApprovalMode.YOLO) {
    decision = PolicyDecision.ALLOW;
  } else {
    if (toolName && SHELL_TOOL_NAMES.includes(toolName)) {
      let heuristicDecision = this.defaultDecision;
      if (!skipHeuristics && command) {
        heuristicDecision = await this.applyShellHeuristics(command, heuristicDecision, shellDirPath);
      }
      const shellResult = await this.checkShellCommand(toolName, command, heuristicDecision, ...);
      decision = shellResult.decision;
    } else {
      decision = this.defaultDecision;
    }
  }
}
```
For any **non-shell** tool (`write_file`, `edit`, any custom SDK tool) with no matching rule, `decision = this.defaultDecision` directly — `ALLOW`, no confirmation, no further check of any kind.

For shell tool calls, there *is* an extra heuristic pass (`applyShellHeuristics` → `sandboxManager.isDangerousCommand(...)`), which forces `ASK_USER` for commands the heuristic specifically recognizes as dangerous. But I traced `applyShellHeuristics`: if the heuristic does **not** flag the command (an inherently incomplete pattern list, not an allowlist), it falls through and returns the original `decision` unchanged — meaning any shell command not on that specific dangerous-pattern list also inherits the raw `ALLOW` default.

**`GeminiCliAgentOptions` (`packages/sdk/src/types.ts`) — the full public API surface, no policy field exists:**
```ts
export interface GeminiCliAgentOptions {
  instructions: SystemInstructions;
  tools?: Array<Tool<any>>;
  skills?: SkillReference[];
  model?: string;
  cwd?: string;
  debug?: boolean;
  recordResponses?: string;
  fakeResponses?: string;
}
```
No `policy`, `approvalMode`, `defaultDecision`, or anything adjacent.

## Proof of Concept

I constructed the real, unmodified `PolicyEngine` (imported directly from `@google/gemini-cli-core`, no source changes) with the exact `policyEngineConfig` object `session.ts` uses, and called its real `check()` method with a `write_file` tool call matching no rule — the situation any SDK-based agent's most basic tool hits by default.

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

Captured output (attached, `captured-output.txt`):
```
✓ write_file with no matching rule is silently ALLOWED under the SDK default config
✓ control: the ENGINE'S OWN built-in default (no override) is ASK_USER, not ALLOW
```

The control test (`new PolicyEngine({})`, no override at all) confirms `ASK_USER` is what the engine itself falls back to when a consumer doesn't specify anything — isolating that the SDK is making an active, deliberate choice to be less safe, not just inheriting a bad upstream default.

A GitHub Actions workflow (attached, `verify-poc.yml`) reproduces the same steps on independent infrastructure.

Verified against commit `9c1b0a610534d6f8120964cf2672c07807d8fc90`.

## Impact

- Any application built with `@google/gemini-cli-sdk` — following the README's own quick-start example — has every tool call the model makes silently approved by default, for any tool that isn't covered by a rule the developer configures themselves. There is currently no field in the public `GeminiCliAgentOptions` API to change this.
- This isn't scoped to one endpoint or one precondition chain like my other reports — it's a property of the SDK itself, so it affects every consumer of the published package equally, unless they reach past the documented API into the internal `Config`/`PolicyEngine` types directly (undocumented, and most developers following the README wouldn't do this).
- Shell commands get partial protection via a dangerous-command heuristic, but that heuristic is a pattern list, not an allowlist — anything it doesn't recognize falls through to the same raw `ALLOW`.
- `mcpEnabled: false` and `enableHooks: false` do meaningfully reduce scope (no MCP-server or extension-hook command execution path here) — I want to be accurate that this is about the SDK's core/custom tool surface, not every capability gemini-cli has elsewhere.

## Other call sites checked (per our process, before writing this up)

- Grepped every place `new Config(` / `approvalMode:` is set outside the main CLI's own `packages/cli/src/config/config.ts` (which *does* correctly force approval mode to `DEFAULT` in untrusted folders — that protective logic exists, just not here). Two other direct `Config`-constructing entry points exist (`packages/sdk/src/session.ts`, `packages/a2a-server/src/config/config.ts`); this report covers the SDK path specifically.
- Confirmed `defaultDecision` is a policy-engine-wide fallback used consistently (single implementation, one place it's read), not duplicated logic that could differ elsewhere.
- Confirmed via `GeminiCliAgentOptions` that there's no public override, so this isn't a "the developer forgot to configure something documented" situation.

## Honest caveats

- **This requires the SDK to actually be used to build something** — it's not itself a live, attacker-reachable endpoint the way the cdap-ui findings were. The realistic risk path is: a developer builds an agent on this SDK (very plausibly including file-write and/or shell tools, since that's the SDK's whole purpose), the agent processes some untrusted input (a user prompt, a document, a webpage — whatever the application's actual use case is), and a prompt-injection-style instruction in that input causes the model to make a tool call that would previously have needed human approval. I have not built and attacked a real downstream application — I'm reporting the SDK's own default configuration and its lack of an override path, which I've verified directly and completely.
- I have not exhaustively audited every tool exposed through `mcp-client.ts`/`mcp-tool.ts` or other paths to rule out additional context; I focused on what `session.ts` itself wires up, which is enough to establish the core issue.
- No claims about severity tier or reward — that's Google's call, and I recognize this is architecturally different from a single exploitable bug, so I'm not sure how it maps onto the usual categories. Wanted to surface it regardless since I think it's a real gap.
