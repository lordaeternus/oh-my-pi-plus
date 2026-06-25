# Advisor Execution Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add user-selectable Advisor execution modes that reduce token use while preserving the current behavior by default and keeping this fork easy to rebase onto upstream.

**Architecture:** Keep the Advisor runtime intact. Add small scheduling logic in `AgentSession` that decides *when* to call the existing `AdvisorRuntime.onTurnEnd(...)`. Expose the new knobs through `settings-schema.ts`, which automatically makes them appear in `/settings` under Model → Advisor.

**Tech Stack:** TypeScript, Bun, existing settings schema/UI generator, existing `AdvisorRuntime`, existing `/advisor` slash command, Bun test.

---

## Compatibility rules

- Default behavior stays byte-for-byte conceptually the same: `advisor.mode = "every-turn"`, `advisor.includeThinking = true`.
- Do not rename `advisor.enabled`, `advisor.subagents`, `advisor.syncBacklog`, or `advisor.immuneTurns`.
- Do not rewrite `AdvisorRuntime`; only add a tiny host option for thinking if needed.
- Keep the diff localized to Advisor settings, Advisor scheduling, tests, and docs.
- Rebase workflow for this fork: fetch upstream first, implement on a feature branch, then rebase the branch onto `upstream/main` before merging into the fork.

## File map

- Modify `packages/coding-agent/src/config/settings-schema.ts`
  - Add `advisor.mode` enum with `/settings` options.
  - Add `advisor.includeThinking` boolean as a direct token-saving knob.
- Modify `packages/coding-agent/src/session/agent-session.ts`
  - Replace unconditional per-turn Advisor call with a small scheduler helper.
  - Trigger reviews for `every-turn`, `end-of-task`, `risk-only`, and `manual`.
- Modify `packages/coding-agent/src/advisor/runtime.ts`
  - Make `includeThinking` configurable through the runtime host, defaulting to current `true` behavior.
- Modify `packages/coding-agent/src/slash-commands/builtin-registry.ts`
  - Add `/advisor review` for manual mode.
  - Show mode in `/advisor status` if useful.
- Modify `packages/coding-agent/src/advisor/__tests__/advisor.test.ts`
  - Add focused tests for scheduling and thinking inclusion.
- Modify docs last:
  - `docs/settings.md`
  - `docs/advisor-watchdog.md`
  - `packages/coding-agent/CHANGELOG.md`

---

### Task 1: Add Advisor settings

**Files:**
- Modify: `packages/coding-agent/src/config/settings-schema.ts`
- Test: existing typecheck via `bun --cwd=packages/coding-agent run check:types`

- [ ] **Step 1: Add enum values near the Advisor settings**

Add constants near the Advisor block or nearby schema constants:

```ts
export const ADVISOR_MODE_VALUES = ["every-turn", "end-of-task", "risk-only", "manual"] as const;
export type AdvisorMode = (typeof ADVISOR_MODE_VALUES)[number];
```

- [ ] **Step 2: Add `advisor.mode` before `advisor.subagents`**

```ts
"advisor.mode": {
	type: "enum",
	values: ADVISOR_MODE_VALUES,
	default: "every-turn",
	ui: {
		tab: "model",
		group: "Advisor",
		label: "Advisor Mode",
		description: "Choose when the advisor reviews the session. Every turn preserves the current behavior; other modes reduce token use.",
		options: [
			{ value: "every-turn", label: "Every turn", description: "Review after each primary turn. Highest coverage, highest token use." },
			{ value: "end-of-task", label: "End of task", description: "Review when the agent submits its final result. Lower token use." },
			{ value: "risk-only", label: "Risk only", description: "Review only after edits, failed tools, or other risky activity." },
			{ value: "manual", label: "Manual", description: "Review only when /advisor review is used." },
		],
		condition: "advisorEnabled",
	},
},
```

- [ ] **Step 3: Add `advisor.includeThinking` after `advisor.mode`**

```ts
"advisor.includeThinking": {
	type: "boolean",
	default: true,
	ui: {
		tab: "model",
		group: "Advisor",
		label: "Advisor Reads Thinking",
		description: "Include assistant thinking in advisor updates. Turning this off can reduce advisor input tokens.",
		condition: "advisorEnabled",
	},
},
```

- [ ] **Step 4: Verify schema types**

Run:

```bash
bun --cwd=packages/coding-agent run check:types
```

Expected: typecheck passes or reports only unrelated pre-existing errors.

---

### Task 2: Make thinking inclusion configurable

**Files:**
- Modify: `packages/coding-agent/src/advisor/runtime.ts`
- Modify: `packages/coding-agent/src/session/agent-session.ts`
- Test: `packages/coding-agent/src/advisor/__tests__/advisor.test.ts`

- [ ] **Step 1: Extend `AdvisorRuntimeHost`**

In `runtime.ts`:

```ts
export interface AdvisorRuntimeHost {
	snapshotMessages(): AgentMessage[];
	enqueueAdvice(note: string, severity?: "nit" | "concern" | "blocker"): void;
	obfuscator?: SecretObfuscator;
	includeThinking?: () => boolean;
	maintainContext?(incomingTokens: number): Promise<boolean>;
}
```

- [ ] **Step 2: Use the host option in `#renderDelta`**

Change the formatter options from fixed `includeThinking: true` to:

```ts
const md = formatSessionHistoryMarkdown(formattedDelta, {
	includeThinking: this.host.includeThinking?.() ?? true,
	includeToolIntent: true,
	watchedRoles: true,
	expandPrimaryContext: true,
});
```

- [ ] **Step 3: Pass the setting from `AgentSession`**

In the `new AdvisorRuntime(...)` host object:

```ts
includeThinking: () => this.settings.get("advisor.includeThinking"),
```

- [ ] **Step 4: Add a runtime test**

Add a test beside the existing `AdvisorRuntime` tests:

```ts
it("omits thinking from advisor deltas when includeThinking is false", async () => {
	const promptInputs: string[] = [];
	const agent = makeAgent(promptInputs);
	const messages: AgentMessage[] = [
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "private chain" },
				{ type: "text", text: "visible answer" },
			],
			timestamp: 1,
		} as AgentMessage,
	];
	const host: AdvisorRuntimeHost = {
		snapshotMessages: () => messages,
		enqueueAdvice: () => {},
		includeThinking: () => false,
	};
	const runtime = new AdvisorRuntime(agent, host);

	runtime.onTurnEnd(messages);
	await Promise.resolve();

	expect(promptInputs[0]).toContain("visible answer");
	expect(promptInputs[0]).not.toContain("private chain");
});
```

- [ ] **Step 5: Run focused test**

Run:

```bash
bun --cwd=packages/coding-agent test src/advisor/__tests__/advisor.test.ts
```

Expected: Advisor tests pass.

---

### Task 3: Add Advisor scheduling helper

**Files:**
- Modify: `packages/coding-agent/src/session/agent-session.ts`
- Test: focused tests added in Task 4

- [ ] **Step 1: Add minimal state fields**

Near the existing Advisor fields:

```ts
#advisorRiskPending = false;
```

- [ ] **Step 2: Add risk marker helper**

```ts
#markAdvisorRiskFromToolResult(toolName: string | undefined, isError: boolean | undefined): void {
	if (!toolName) return;
	if (isError) {
		this.#advisorRiskPending = true;
		return;
	}
	if (toolName === "edit" || toolName === "write" || toolName === "ast_edit") {
		this.#advisorRiskPending = true;
	}
}
```

Keep it intentionally small. No command parsing, no fragile bash heuristics.

- [ ] **Step 3: Call the marker in existing tool-result handling**

Inside the existing `event.message.role === "toolResult"` block, after extracting `toolName` and `isError`:

```ts
this.#markAdvisorRiskFromToolResult(toolName, isError);
```

- [ ] **Step 4: Add one Advisor review helper**

```ts
async #runAdvisorReviewIfNeeded(
	messages: AgentMessage[],
	signal: AbortSignal | undefined,
	reason: "turn" | "task-end" | "risk" | "manual",
): Promise<boolean> {
	if (!this.#advisorRuntime || this.#advisorRuntime.disposed) return false;
	const mode = this.settings.get("advisor.mode");
	const shouldRun =
		mode === "every-turn" ||
		(mode === "end-of-task" && reason === "task-end") ||
		(mode === "risk-only" && (reason === "risk" || reason === "task-end") && this.#advisorRiskPending) ||
		(mode === "manual" && reason === "manual");
	if (!shouldRun) return false;

	this.#advisorRuntime.onTurnEnd(messages);
	if (reason === "risk" || reason === "task-end") this.#advisorRiskPending = false;

	const syncBacklog = this.settings.get("advisor.syncBacklog");
	if (syncBacklog !== "off") {
		const threshold = parseInt(syncBacklog, 10);
		await this.#advisorRuntime.waitForCatchup(30000, threshold, signal);
	}
	return true;
}
```

- [ ] **Step 5: Replace the unconditional per-turn block**

Replace the current block in `setOnTurnEnd`:

```ts
if (this.#advisorRuntime && !this.#advisorRuntime.disposed) {
	this.#advisorRuntime.onTurnEnd(messages);
	const syncBacklog = this.settings.get("advisor.syncBacklog");
	if (syncBacklog !== "off") {
		const threshold = parseInt(syncBacklog, 10);
		await this.#advisorRuntime.waitForCatchup(30000, threshold, signal);
	}
}
```

with:

```ts
await this.#runAdvisorReviewIfNeeded(
	messages,
	signal,
	this.settings.get("advisor.mode") === "risk-only" && this.#advisorRiskPending ? "risk" : "turn",
);
```

- [ ] **Step 6: Trigger end-of-task review on successful yield**

In the `yieldOnThisMessage || this.#yieldTerminationPending` branch, before `emitAgentEndNotification()` returns:

```ts
if (yieldOnThisMessage) {
	await this.#runAdvisorReviewIfNeeded(settledMessages, undefined, "task-end");
}
```

This uses the existing terminal `yield` signal instead of inventing a new task lifecycle.

---

### Task 4: Add manual review command

**Files:**
- Modify: `packages/coding-agent/src/session/agent-session.ts`
- Modify: `packages/coding-agent/src/slash-commands/builtin-registry.ts`

- [ ] **Step 1: Add a public session method**

Near `setAdvisorEnabled` / `getAdvisorStats`:

```ts
async requestAdvisorReview(): Promise<boolean> {
	if (!this.#buildAdvisorRuntime(true)) return false;
	return this.#runAdvisorReviewIfNeeded(this.agent.state.messages, undefined, "manual");
}
```

- [ ] **Step 2: Add slash command metadata**

Extend `/advisor` subcommands:

```ts
{ name: "review", description: "Run one advisor review now" },
```

Update hints:

```ts
acpInputHint: "[on|off|status|review|dump [raw]]",
```

- [ ] **Step 3: Add non-TUI handler**

```ts
if (verb === "review") {
	const queued = await runtime.session.requestAdvisorReview();
	await runtime.output(queued ? "Advisor review queued." : "Advisor is not active for this session.");
	return commandConsumed();
}
```

- [ ] **Step 4: Add TUI handler**

```ts
if (verb === "review") {
	const queued = await runtime.ctx.session.requestAdvisorReview();
	runtime.ctx.showStatus(queued ? "Advisor review queued." : "Advisor is not active for this session.");
	runtime.ctx.editor.setText("");
	return;
}
```

- [ ] **Step 5: Update usage string**

```ts
return usage("Usage: /advisor [on|off|status|review|dump [raw]]", runtime);
```

---

### Task 5: Add focused behavior tests

**Files:**
- Modify: `packages/coding-agent/src/advisor/__tests__/advisor.test.ts`

- [ ] **Step 1: Keep runtime tests small**

Do not instantiate a full `AgentSession` unless existing test helpers already make that cheap. Prefer testing the pure/runtime behavior where possible.

- [ ] **Step 2: Add tests for skipped deltas staying queued**

```ts
it("manual mode can review accumulated skipped deltas", async () => {
	const promptInputs: string[] = [];
	const agent = makeAgent(promptInputs);
	const messages: AgentMessage[] = [{ role: "user", content: "first", timestamp: 1 } as AgentMessage];
	const host: AdvisorRuntimeHost = { snapshotMessages: () => messages, enqueueAdvice: () => {} };
	const runtime = new AdvisorRuntime(agent, host);

	messages.push({ role: "assistant", content: "second", timestamp: 2 } as AgentMessage);
	runtime.onTurnEnd(messages);
	await Promise.resolve();

	expect(promptInputs[0]).toContain("first");
	expect(promptInputs[0]).toContain("second");
});
```

If a full scheduler helper is extracted, replace this with direct scheduler tests. If not extracted, rely on session-level tests only if existing helpers exist.

- [ ] **Step 3: Add settings UI definition test if a settings test file exists**

Expected assertions:

```ts
const mode = getSettingDef("advisor.mode");
expect(mode?.type).toBe("submenu");
expect(mode?.label).toBe("Advisor Mode");
```

Only add this if there is already a nearby settings-defs test pattern. Do not create a heavy UI test harness just for this.

- [ ] **Step 4: Run focused tests**

Run:

```bash
bun --cwd=packages/coding-agent test src/advisor/__tests__/advisor.test.ts
```

Expected: pass.

---

### Task 6: Update docs and changelog last

**Files:**
- Modify: `docs/settings.md`
- Modify: `docs/advisor-watchdog.md`
- Modify: `packages/coding-agent/CHANGELOG.md`

- [ ] **Step 1: Update `docs/settings.md` Advisor table**

Add rows:

```md
| `advisor.mode` | enum | `every-turn` | When the advisor reviews: `every-turn`, `end-of-task`, `risk-only`, or `manual`. |
| `advisor.includeThinking` | boolean | `true` | Include assistant thinking in advisor updates. Turn off to reduce advisor input tokens. |
```

- [ ] **Step 2: Update `docs/advisor-watchdog.md` commands**

Add:

```md
| `/advisor review` | Queue one advisor review immediately. Useful with `advisor.mode: manual`. |
```

Update intro wording from “after each turn” to:

```md
The advisor reviews according to `advisor.mode`; by default it reviews after each turn.
```

- [ ] **Step 3: Add changelog entry**

Under `packages/coding-agent/CHANGELOG.md` → `## [Unreleased]` → `### Added`:

```md
- Added configurable advisor review modes and a manual `/advisor review` command, with an option to omit assistant thinking from advisor updates to reduce token use.
```

---

### Task 7: Final verification

**Files:**
- No new files beyond this plan.

- [ ] **Step 1: Run focused Advisor tests**

```bash
bun --cwd=packages/coding-agent test src/advisor/__tests__/advisor.test.ts
```

Expected: pass.

- [ ] **Step 2: Run package typecheck**

```bash
bun --cwd=packages/coding-agent run check:types
```

Expected: pass.

- [ ] **Step 3: Manual smoke through `/settings`**

Start the app locally and open `/settings`.

Expected under Model → Advisor after enabling Advisor:

- Advisor Mode
- Advisor Reads Thinking
- Advisor for Subagents
- Advisor Sync Backlog
- Advisor Immune Turns

- [ ] **Step 4: Manual smoke for `/advisor review`**

With `advisor.enabled: true`, `modelRoles.advisor` configured, and `advisor.mode: manual`:

```text
/advisor review
```

Expected: status says `Advisor review queued.` and the Advisor transcript receives one new update.

---

## Recommended implementation order

1. Settings schema first: lowest-risk, makes `/settings` work automatically.
2. Thinking toggle second: direct token reduction, tiny diff.
3. Scheduling helper third: main behavior change, still localized.
4. Manual command fourth: makes `manual` mode usable.
5. Tests/docs/changelog last.

## Specialist opinion

Best default for upstream compatibility: `every-turn`.

Best default for your fork if you accept behavior change: `risk-only`.

Best practical rollout: ship with upstream-compatible default, then set your personal config to:

```yaml
advisor:
  enabled: true
  mode: risk-only
  includeThinking: false
```
