/**
 * Security repro: @google/gemini-cli SDK ships an insecure-by-default
 * PolicyEngine configuration.
 *
 * packages/sdk/src/session.ts constructs every GeminiCliSession's Config
 * with:
 *   policyEngineConfig: {
 *     // TODO: Revisit this default when we have a mechanism for wiring up approvals
 *     defaultDecision: PolicyDecision.ALLOW,
 *   },
 *
 * PolicyEngine's own constructor shows what the *safe* built-in default
 * actually is when defaultDecision isn't overridden:
 *   this.defaultDecision =
 *     config.defaultDecision ??
 *     (this.nonInteractive ? PolicyDecision.DENY : PolicyDecision.ASK_USER);
 *
 * So the SDK is deliberately overriding "ask the user" / "deny" with
 * "allow everything that doesn't match a specific rule" -- for every
 * application built on this SDK, unless that developer notices and
 * overrides it themselves.
 *
 * This test constructs the real, unmodified PolicyEngine with the exact
 * same policyEngineConfig object the SDK uses, and checks a `write_file`
 * tool call that matches no configured rule -- exactly the situation any
 * SDK-based agent hits for its most basic, commonly-used tool.
 */
import { describe, it, expect } from 'vitest';
import { PolicyEngine, PolicyDecision } from '@google/gemini-cli-core';

describe('security repro: SDK ships PolicyDecision.ALLOW as its default', () => {
  it('write_file with no matching rule is silently ALLOWED under the SDK default config', async () => {
    // Exactly packages/sdk/src/session.ts's policyEngineConfig, verbatim.
    const engine = new PolicyEngine({
      defaultDecision: PolicyDecision.ALLOW,
    });

    const result = await engine.check(
      { name: 'write_file', args: { file_path: '/home/user/.bashrc', content: 'malicious content' } },
      undefined,
    );

    expect(result.decision).toBe(PolicyDecision.ALLOW);
    expect(result.rule).toBeUndefined(); // no rule matched -- this is the bare default kicking in
  });

  it('control: the ENGINE\'S OWN built-in default (no override) is ASK_USER, not ALLOW', async () => {
    // No defaultDecision override at all -- this is what PolicyEngine
    // itself considers safe when a consumer doesn't specify anything.
    const engine = new PolicyEngine({});

    const result = await engine.check(
      { name: 'write_file', args: { file_path: '/home/user/.bashrc', content: 'malicious content' } },
      undefined,
    );

    expect(result.decision).toBe(PolicyDecision.ASK_USER);
  });
});
