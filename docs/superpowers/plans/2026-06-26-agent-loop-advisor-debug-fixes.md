# Agent Loop + Advisor Stop-Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make mid-loop stops visible and make advisor reviews truthful/non-blocking by fixing the confirmed lifecycle and manual-review bugs found during debugging.

**Architecture:** Preserve the current core loop shape. Fix terminal failure visibility at the source (`Agent.#runLoop`) so every provider failure emits the same assistant lifecycle events the coding-agent UI/session pipeline already consumes. Keep `AdvisorRuntime` delta-oriented for normal modes, but add an explicit full-review/manual path so `/advisor review` cannot report “queued” when no advisor prompt was queued.

**Tech Stack:** Bun test, TypeScript, `@oh-my-pi/pi-agent-core`, `@oh-my-pi/pi-coding-agent`, existing AgentSession and AdvisorRuntime test patterns.

---

## File Structure

- Modify `packages/agent/src/agent.ts`
  - Source fix for generic provider stream failures: emit `message_start`, `message_end`, and `turn_end` before `agent_end`, matching existing visible-error behavior.
- Modify `packages/agent/test/agent.test.ts`
  - Update the existing generic provider failure test so it asserts visible assistant lifecycle instead of absence of lifecycle.
- Modify `packages/coding-agent/src/advisor/runtime.ts`
  - Return whether `onTurnEnd` actually queued a delta.
  - Add a full transcript review path for manual reviews.
- Modify `packages/coding-agent/src/session/agent-session.ts`
  - Use the new AdvisorRuntime return value so `requestAdvisorReview()` reports false when no review was queued.
  - Use the full transcript path for manual `/advisor review`, including immediately after enabling advisor mid-session.
  - Keep normal every-turn/end-of-task/risk-only behavior delta-based.
- Modify `packages/coding-agent/src/advisor/__tests__/advisor.test.ts`
  - Remove the malformed dangling line currently breaking parsing.
  - Add AdvisorRuntime tests for queued/no-op return values and full review.
- Modify `packages/coding-agent/src/advisor/__tests__/advisor-runtime-modes.test.ts`
  - Add a regression test documenting manual full review vs delta review if a separate file is cleaner after the runtime API change.
- Modify `packages/coding-agent/test/advisor-toggle.test.ts`
  - Add the session-level regression for enable-mid-session then manual review.
- Optional modify `packages/coding-agent/src/session/agent-session.ts`
  - Expand `#markAdvisorRiskFromToolResult` only if product decision is that `risk-only` must include other side-effectful tools such as `bash`/`eval`. If not, update UI copy instead.

---

### Task 1: Make generic provider failures visible

**Files:**
- Modify: `packages/agent/test/agent.test.ts:160-188`
- Modify: `packages/agent/src/agent.ts:1236-1283`

- [ ] **Step 1: Rewrite the failing regression test**

Replace the existing test named `prompt() keeps unrelated provider stream failures out of the assistant lifecycle` with:

```ts
it("prompt() emits assistant error lifecycle for generic provider stream failures", async () => {
	const mock = createMockModel({ responses: [] });
	const errorText = "connection reset";
	const agent = new Agent({
		initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn: () => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => stream.fail(new Error(errorText)));
			return stream;
		},
	});
	const events: AgentEvent[] = [];
	const unsubscribe = agent.subscribe(event => events.push(event));

	await agent.prompt("trigger");
	unsubscribe();

	const assistantStarts = events.filter(
		event => event.type === "message_start" && event.message.role === "assistant",
	);
	const assistantEnds = events.filter(event => event.type === "message_end" && event.message.role === "assistant");
	const turnEnds = events.filter(event => event.type === "turn_end" && event.message.role === "assistant");

	expect(assistantStarts).toHaveLength(1);
	expect(assistantEnds).toHaveLength(1);
	expect(turnEnds).toHaveLength(1);

	const assistantEnd = assistantEnds[0];
	if (assistantEnd?.type !== "message_end" || assistantEnd.message.role !== "assistant") {
		throw new Error("assistant message_end not emitted");
	}
	expect(assistantEnd.message.stopReason).toBe("error");
	expect(assistantEnd.message.errorMessage).toBe(errorText);

	const agentEnd = events.find(event => event.type === "agent_end");
	if (agentEnd?.type !== "agent_end") {
		throw new Error("agent_end not emitted");
	}
	expect(agentEnd.messages.at(-1)).toBe(assistantEnd.message);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
bun test packages/agent/test/agent.test.ts -t "generic provider stream failures"
```

Expected: FAIL because the current code emits `agent_end` only and does not emit assistant `message_start`, `message_end`, or `turn_end` for generic provider stream failures.

- [ ] **Step 3: Implement the source fix**

In `packages/agent/src/agent.ts`, replace the special-case visible-error branch with a helper path that emits visible lifecycle for every caught assistant error. The resulting catch section should keep the existing output-blocked partial-message behavior but no longer hide generic failures from lifecycle listeners:

```ts
const shouldReuseAssistantPartial = shouldEmitVisibleOutputBlockedError && assistantPartial;
const errorMsg: AssistantMessage = shouldReuseAssistantPartial
	? { ...assistantPartial, stopReason: "error", errorMessage }
	: {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: stoppedForAbort ? "aborted" : "error",
			errorMessage,
			timestamp: Date.now(),
		};

if (!hadAssistantStart) {
	this.#state.streamMessage = errorMsg;
	this.#emit({ type: "message_start", message: errorMsg });
}
this.#state.streamMessage = null;
this.appendMessage(errorMsg);
this.#state.error = errorMessage;
this.#emit({ type: "message_end", message: errorMsg });
this.#emit({ type: "turn_end", message: errorMsg, toolResults: [] });
this.#emit({ type: "agent_end", messages: [errorMsg] });
```

Keep the abort behavior visible too; it already maps to `stopReason: "aborted"` and the UI has suppression rules for deliberate/silent aborts.

- [ ] **Step 4: Run focused core tests**

Run:

```bash
bun test packages/agent/test/agent.test.ts packages/agent/test/agent-loop.test.ts
```

Expected: PASS. This verifies the changed lifecycle and existing abort/deadline/tool-loop behavior.

---

### Task 2: Repair malformed advisor runtime test file

**Files:**
- Modify: `packages/coding-agent/src/advisor/__tests__/advisor.test.ts:489`

- [ ] **Step 1: Remove the dangling unterminated test line**

Delete the malformed line:

```ts
	it("does not
```

Do not delete the following `it("budgets only the batch sent after async context maintenance", ...)` test.

- [ ] **Step 2: Run the advisor unit test file and verify parsing succeeds**

Run:

```bash
bun test packages/coding-agent/src/advisor/__tests__/advisor.test.ts
```

Expected: the file parses and test execution proceeds. If there are runtime failures, keep them; do not mask them with syntax-only changes.

---

### Task 3: Make AdvisorRuntime report whether work was queued

**Files:**
- Modify: `packages/coding-agent/src/advisor/runtime.ts:83-94`
- Modify: `packages/coding-agent/src/advisor/__tests__/advisor.test.ts` inside `describe("AdvisorRuntime", ...)`

- [ ] **Step 1: Add failing tests for queue acknowledgement**

Add these tests inside `describe("AdvisorRuntime", ...)`:

```ts
it("reports false when a delta review has no new transcript", () => {
	const promptInputs: string[] = [];
	const agent = makeAgent(promptInputs);
	const messages: AgentMessage[] = [{ role: "user", content: "first", timestamp: 1 } as AgentMessage];
	const host: AdvisorRuntimeHost = {
		snapshotMessages: () => messages,
		enqueueAdvice: () => {},
	};
	const runtime = new AdvisorRuntime(agent, host);

	expect(runtime.onTurnEnd(messages)).toBe(true);
	expect(runtime.onTurnEnd(messages)).toBe(false);
});

it("reports true when a later delta is queued", () => {
	const promptInputs: string[] = [];
	const agent = makeAgent(promptInputs);
	const messages: AgentMessage[] = [{ role: "user", content: "first", timestamp: 1 } as AgentMessage];
	const host: AdvisorRuntimeHost = {
		snapshotMessages: () => messages,
		enqueueAdvice: () => {},
	};
	const runtime = new AdvisorRuntime(agent, host);

	expect(runtime.onTurnEnd(messages)).toBe(true);
	messages.push({ role: "assistant", content: [{ type: "text", text: "second" }], timestamp: 2 } as AgentMessage);
	expect(runtime.onTurnEnd(messages)).toBe(true);
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
bun test packages/coding-agent/src/advisor/__tests__/advisor.test.ts -t "reports"
```

Expected: FAIL because `AdvisorRuntime.onTurnEnd` currently returns `void`.

- [ ] **Step 3: Change `AdvisorRuntime.onTurnEnd` to return boolean**

Update `onTurnEnd` to:

```ts
onTurnEnd(messages?: AgentMessage[]): boolean {
	if (this.disposed) return false;
	const all = messages ?? this.host.snapshotMessages();
	this.#latestMessages = all;
	const render = this.#renderDelta(all);
	if (!render) return false;
	this.#pending.push({ text: render, turns: 1 });
	this.#backlog++;
	this.#notifyWaiters();
	void this.#drain();
	return true;
}
```

- [ ] **Step 4: Run advisor runtime tests**

Run:

```bash
bun test packages/coding-agent/src/advisor/__tests__/advisor.test.ts packages/coding-agent/src/advisor/__tests__/advisor-runtime-modes.test.ts
```

Expected: PASS.

---

### Task 4: Add full-transcript manual advisor review

**Files:**
- Modify: `packages/coding-agent/src/advisor/runtime.ts`
- Modify: `packages/coding-agent/src/advisor/__tests__/advisor.test.ts` inside `describe("AdvisorRuntime", ...)`

- [ ] **Step 1: Add a failing full-review test**

Add this test inside `describe("AdvisorRuntime", ...)`:

```ts
it("manual full review sends the current transcript after seedToCurrent", async () => {
	const promptInputs: string[] = [];
	const agent = makeAgent(promptInputs);
	const messages: AgentMessage[] = [
		{ role: "user", content: "before enabling", timestamp: 1 } as AgentMessage,
		{ role: "assistant", content: [{ type: "text", text: "existing answer" }], timestamp: 2 } as AgentMessage,
	];
	const host: AdvisorRuntimeHost = {
		snapshotMessages: () => messages,
		enqueueAdvice: () => {},
	};
	const runtime = new AdvisorRuntime(agent, host);
	runtime.seedTo(messages.length);

	expect(runtime.reviewAll(messages)).toBe(true);
	await Promise.resolve();

	expect(promptInputs).toHaveLength(1);
	expect(promptInputs[0]).toContain("before enabling");
	expect(promptInputs[0]).toContain("existing answer");
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
bun test packages/coding-agent/src/advisor/__tests__/advisor.test.ts -t "manual full review"
```

Expected: FAIL because `reviewAll` does not exist.

- [ ] **Step 3: Implement `reviewAll` in AdvisorRuntime**

Add this method near `onTurnEnd`:

```ts
reviewAll(messages?: AgentMessage[]): boolean {
	if (this.disposed) return false;
	const all = messages ?? this.host.snapshotMessages();
	this.#latestMessages = all;
	const previousLastCount = this.#lastCount;
	this.#lastCount = 0;
	this.#seenContext.clear();
	const render = this.#renderDelta(all);
	if (!render) {
		this.#lastCount = previousLastCount;
		return false;
	}
	this.#pending.push({ text: render, turns: 1 });
	this.#backlog++;
	this.#notifyWaiters();
	void this.#drain();
	return true;
}
```

This deliberately sets the cursor to `all.length` through `#renderDelta(all)`, so subsequent delta reviews do not replay the whole transcript again.

- [ ] **Step 4: Run advisor runtime tests**

Run:

```bash
bun test packages/coding-agent/src/advisor/__tests__/advisor.test.ts packages/coding-agent/src/advisor/__tests__/advisor-runtime-modes.test.ts
```

Expected: PASS.

---

### Task 5: Make AgentSession manual advisor review truthful

**Files:**
- Modify: `packages/coding-agent/src/session/agent-session.ts:1836-1855`
- Modify: `packages/coding-agent/src/session/agent-session.ts:13212-13215`
- Modify: `packages/coding-agent/test/advisor-toggle.test.ts`

- [ ] **Step 1: Add a failing session-level regression**

In `packages/coding-agent/test/advisor-toggle.test.ts`, add a test following the file’s existing setup helpers. The test should create a session with an advisor model role, append existing transcript messages before enabling advisor, enable advisor, request review, and assert the advisor prompt receives the existing transcript. Use the local mock advisor model pattern already used in this file; the assertion body should be:

```ts
expect(queued).toBe(true);
expect(advisorPrompts).toHaveLength(1);
expect(advisorPrompts[0]).toContain("message before advisor enabled");
expect(advisorPrompts[0]).toContain("answer before advisor enabled");
```

Use these transcript messages before `setAdvisorEnabled(true)`:

```ts
session.agent.appendMessage({ role: "user", content: "message before advisor enabled", timestamp: 1 });
session.agent.appendMessage({
	role: "assistant",
	content: [{ type: "text", text: "answer before advisor enabled" }],
	api: "mock",
	provider: "mock",
	model: "mock-advisor-primary",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 2,
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
bun test packages/coding-agent/test/advisor-toggle.test.ts -t "manual"
```

Expected: FAIL on current code because `setAdvisorEnabled(true)` seeds the cursor to current message count and `requestAdvisorReview()` uses the delta path.

- [ ] **Step 3: Update `#runAdvisorReviewIfNeeded` to distinguish manual review**

Change the queuing line from:

```ts
this.#advisorRuntime.onTurnEnd(messages);
```

to:

```ts
const queued = reason === "manual" ? this.#advisorRuntime.reviewAll(messages) : this.#advisorRuntime.onTurnEnd(messages);
if (!queued) return false;
```

Keep `#advisorRiskPending = false` after the `queued` check, not before it.

- [ ] **Step 4: Keep `requestAdvisorReview` return value accurate**

Leave the public method as:

```ts
async requestAdvisorReview(): Promise<boolean> {
	if (!this.#buildAdvisorRuntime()) return false;
	return this.#runAdvisorReviewIfNeeded(this.agent.state.messages, undefined, "manual");
}
```

After Step 3, this returns false when no advisor runtime exists and true only when the runtime accepted real review work.

- [ ] **Step 5: Run advisor session tests**

Run:

```bash
bun test packages/coding-agent/test/advisor-toggle.test.ts packages/coding-agent/test/agent-session-advisor-suppression.test.ts
```

Expected: PASS.

---

### Task 6: Decide and lock down risk-only semantics

**Files:**
- Modify: `packages/coding-agent/src/session/agent-session.ts:1825-1833` or `packages/coding-agent/src/config/settings-schema.ts:421-424`
- Modify: `packages/coding-agent/src/advisor/__tests__/advisor-modes.test.ts` or a focused AgentSession advisor test

- [ ] **Step 1: Choose the contract**

Use one of these two contracts:

1. Conservative code contract: risk-only means failed tools plus successful `edit`, `write`, and `ast_edit` only.
2. Broader product contract: risk-only includes failed tools plus successful file/process mutators such as `edit`, `write`, `ast_edit`, `bash`, `eval`, and `browser`.

- [ ] **Step 2A: If choosing conservative code contract, update UI copy**

Change the risk-only description in `packages/coding-agent/src/config/settings-schema.ts` from:

```ts
description: "Review only after edits, failed tools, or other risky activity.",
```

to:

```ts
description: "Review only after edits or failed tools.",
```

- [ ] **Step 2B: If choosing broader product contract, update risk detection**

Change `#markAdvisorRiskFromToolResult` to:

```ts
#markAdvisorRiskFromToolResult(toolName: string | undefined, isError: boolean | undefined): void {
	if (isError) {
		this.#advisorRiskPending = true;
		return;
	}
	if (!toolName) return;
	if (toolName === "edit" || toolName === "write" || toolName === "ast_edit" || toolName === "bash" || toolName === "eval") {
		this.#advisorRiskPending = true;
	}
}
```

Do not include read-only tools (`read`, `search`, `find`).

- [ ] **Step 3: Add a regression test for the chosen contract**

For conservative copy-only change, add a settings-schema/UI test that checks the risk-only label contains `edits or failed tools` and does not contain `other risky activity`.

For broader product contract, add an AgentSession event-path test that emits successful `bash` and verifies `risk-only` advisor review is queued on the next turn. The core assertion should be:

```ts
expect(advisorPrompts).toHaveLength(1);
expect(advisorPrompts[0]).toContain("bash");
```

- [ ] **Step 4: Run the selected focused tests**

Conservative contract:

```bash
bun test packages/coding-agent/test/modes/components/settings-layout.test.ts
```

Broader product contract:

```bash
bun test packages/coding-agent/test/advisor-toggle.test.ts packages/coding-agent/src/advisor/__tests__/advisor-modes.test.ts
```

Expected: PASS.

---

### Task 7: Verify the integrated fix set

**Files:**
- No edits.

- [ ] **Step 1: Run focused advisor and loop tests**

Run:

```bash
bun test packages/agent/test/agent.test.ts packages/agent/test/agent-loop.test.ts packages/coding-agent/src/advisor/__tests__/advisor-modes.test.ts packages/coding-agent/src/advisor/__tests__/advisor-runtime-modes.test.ts packages/coding-agent/src/advisor/__tests__/advisor.test.ts packages/coding-agent/test/advisor-toggle.test.ts packages/coding-agent/test/agent-session-advisor-suppression.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run package typecheck**

Run:

```bash
bun --cwd=packages/coding-agent run check:types
```

Expected: PASS.

- [ ] **Step 3: Run core package tests touched by Agent lifecycle**

Run:

```bash
bun test packages/agent/test/agent.test.ts packages/agent/test/agent-loop.test.ts packages/agent/test/prompt-tools-loop.test.ts
```

Expected: PASS.

---

## Self-Review

**Spec coverage:**
- Deep loop stop debugging: covered by Task 1 and integrated verification.
- Advisor relation: covered by Tasks 3–6.
- Confirmed bugs: generic provider failure lifecycle, malformed advisor unit test file, false `/advisor review queued` after enable-mid-session.
- Bounded advisor pause: documented and verified through existing runtime tests; no source change unless product wants visible status for `syncBacklog` waits.

**Placeholder scan:**
- No `TBD`, `TODO`, or “implement later”.
- Task 6 has an explicit two-option product decision because changing `risk-only` semantics is a behavior choice; both branches include concrete edits/tests.

**Type consistency:**
- New runtime API: `onTurnEnd(...): boolean`, `reviewAll(...): boolean`.
- Session call site uses `reviewAll` only for `reason === "manual"`.
- Existing mode predicate remains unchanged.
