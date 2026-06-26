# Context Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in Context Map that injects a small, task-aware, signature-only repository orientation block without depending on CodeGraph.

**Architecture:** Build a focused `context-map.ts` module that ranks candidate files from cheap native signals, extracts compact signatures with `summarizeCode`, enforces a hard token budget with `countTokens`, and renders a deterministic XML-like block. Wire it into the per-turn system prompt path so the map can use the current user prompt while preserving the stable base prompt prefix.

**Tech Stack:** Bun, TypeScript, `@oh-my-pi/pi-natives` `summarizeCode`/`listWorkspace`, `@oh-my-pi/pi-agent-core` `countTokens`, existing `buildSystemPrompt`/`AgentSession` prompt flow.

**Commit policy:** Do not commit unless the current operator was explicitly asked to commit. Each task ends with a verification checkpoint instead.

---

## File Structure

- Create `packages/coding-agent/src/context-map.ts`
  - Pure builder and renderer for Context Map.
  - Owns candidate ranking, file exclusion, signature extraction, budget enforcement, and deterministic output.
- Create `packages/coding-agent/test/context-map.test.ts`
  - Contract tests for budget, omission of bodies, exclusions, ranking, parse failure, and determinism.
- Modify `packages/coding-agent/src/system-prompt.ts`
  - Add optional `contextMap` input for static prompt rendering tests and custom prompt compatibility.
- Modify `packages/coding-agent/src/prompts/system/project-prompt.md`
  - Render `<context-map>` only when explicitly supplied.
- Modify `packages/coding-agent/src/session/agent-session.ts`
  - Build and append a per-turn Context Map in `#buildSystemPromptForAgentStart(promptText)` when enabled.
- Modify `packages/coding-agent/src/config/settings-schema.ts`
  - Add `contextMap.enabled` and `contextMap.budgetTokens` settings.
- Modify `packages/coding-agent/src/sdk.ts`
  - Read settings and pass context map config into `AgentSession`.
- Modify `packages/coding-agent/test/system-prompt-dedup.test.ts`
  - Add prompt rendering tests for omitted/included Context Map.

---

## Task 1: Context Map module contract tests

**Files:**
- Create: `packages/coding-agent/test/context-map.test.ts`
- Create later in Task 2: `packages/coding-agent/src/context-map.ts`

- [ ] **Step 1: Write failing tests for Context Map behavior**

Create `packages/coding-agent/test/context-map.test.ts`:

```ts
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { countTokens } from "@oh-my-pi/pi-agent-core";
import { buildContextMap } from "@oh-my-pi/pi-coding-agent/context-map";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-context-map-"));
	tempDirs.push(dir);
	return dir;
}

async function writeProjectFile(cwd: string, relativePath: string, content: string): Promise<void> {
	await Bun.write(path.join(cwd, relativePath), content);
}

describe("buildContextMap", () => {
	afterEach(async () => {
		await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
	});

	it("renders signatures without function bodies", async () => {
		const cwd = await makeTempDir();
		await writeProjectFile(
			cwd,
			"src/payments.ts",
			`export interface Receipt {
	id: string;
}

export async function processPayment(userId: string, amount: number): Promise<Receipt> {
	const internalSecret = "body must not leak";
	return { id: internalSecret };
}
`,
		);

		const result = await buildContextMap({
			cwd,
			budgetTokens: 500,
			userPrompt: "update payment processing",
			mentionedFiles: ["src/payments.ts"],
		});

		expect(result.rendered).toContain("<context-map");
		expect(result.rendered).toContain("src/payments.ts");
		expect(result.rendered).toContain("processPayment(userId: string, amount: number): Promise<Receipt>");
		expect(result.rendered).toContain("interface Receipt");
		expect(result.rendered).not.toContain("internalSecret");
		expect(result.rendered).not.toContain("body must not leak");
	});

	it("respects the hard token budget", async () => {
		const cwd = await makeTempDir();
		for (let i = 0; i < 20; i += 1) {
			await writeProjectFile(
				cwd,
				`src/module-${i}.ts`,
				`export function module${i}Alpha(input: string): string { return input; }\nexport function module${i}Beta(input: string): string { return input; }\n`,
			);
		}

		const result = await buildContextMap({
			cwd,
			budgetTokens: 120,
			userPrompt: "module alpha",
		});

		expect(countTokens(result.rendered)).toBeLessThanOrEqual(120);
		expect(result.usedTokens).toBeLessThanOrEqual(120);
		expect(result.truncated).toBe(true);
	});

	it("excludes generated vendor dist and minified files", async () => {
		const cwd = await makeTempDir();
		await writeProjectFile(cwd, "src/real.ts", "export function realFeature(): string { return 'ok'; }\n");
		await writeProjectFile(cwd, "src/client.generated.ts", "export function generatedFeature(): string { return 'bad'; }\n");
		await writeProjectFile(cwd, "dist/bundle.ts", "export function distFeature(): string { return 'bad'; }\n");
		await writeProjectFile(cwd, "vendor/lib.ts", "export function vendorFeature(): string { return 'bad'; }\n");
		await writeProjectFile(cwd, "src/app.min.js", "export function minifiedFeature(){return 'bad'}\n");

		const result = await buildContextMap({ cwd, budgetTokens: 500, userPrompt: "real feature" });

		expect(result.rendered).toContain("src/real.ts");
		expect(result.rendered).not.toContain("client.generated.ts");
		expect(result.rendered).not.toContain("dist/bundle.ts");
		expect(result.rendered).not.toContain("vendor/lib.ts");
		expect(result.rendered).not.toContain("app.min.js");
	});

	it("skips unparsable files without failing", async () => {
		const cwd = await makeTempDir();
		await writeProjectFile(cwd, "src/broken.ts", "export function broken( {\n");
		await writeProjectFile(cwd, "src/good.ts", "export function goodFeature(): string { return 'ok'; }\n");

		const result = await buildContextMap({ cwd, budgetTokens: 500, userPrompt: "good broken" });

		expect(result.rendered).toContain("src/good.ts");
		expect(result.rendered).not.toContain("src/broken.ts");
	});

	it("prioritizes mentioned files over weaker path matches", async () => {
		const cwd = await makeTempDir();
		await writeProjectFile(cwd, "src/weak-payment-match.ts", "export function weakPaymentMatch(): void {}\n");
		await writeProjectFile(cwd, "src/session.ts", "export function createSession(): void {}\n");

		const result = await buildContextMap({
			cwd,
			budgetTokens: 500,
			userPrompt: "payment",
			mentionedFiles: ["src/session.ts"],
		});

		expect(result.files[0]).toBe("src/session.ts");
	});

	it("is deterministic for identical inputs", async () => {
		const cwd = await makeTempDir();
		await writeProjectFile(cwd, "src/a.ts", "export function alpha(): void {}\n");
		await writeProjectFile(cwd, "src/b.ts", "export function beta(): void {}\n");

		const first = await buildContextMap({ cwd, budgetTokens: 500, userPrompt: "alpha beta" });
		const second = await buildContextMap({ cwd, budgetTokens: 500, userPrompt: "alpha beta" });

		expect(second.rendered).toBe(first.rendered);
		expect(second.files).toEqual(first.files);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun test packages/coding-agent/test/context-map.test.ts
```

Expected: FAIL because `@oh-my-pi/pi-coding-agent/context-map` does not exist.

---

## Task 2: Implement `context-map.ts`

**Files:**
- Create: `packages/coding-agent/src/context-map.ts`
- Tests: `packages/coding-agent/test/context-map.test.ts`

- [ ] **Step 1: Create the minimal Context Map builder**

Create `packages/coding-agent/src/context-map.ts`:

```ts
import * as path from "node:path";
import { countTokens } from "@oh-my-pi/pi-agent-core";
import { FileType, listWorkspace, summarizeCode, type SummarySegment } from "@oh-my-pi/pi-natives";

const DEFAULT_BUDGET_TOKENS = 1000;
const MIN_BUDGET_TOKENS = 300;
const MAX_CANDIDATE_FILES = 80;
const MAX_RENDERED_FILES = 20;
const MAX_SIGNATURES_PER_FILE = 8;
const CONTEXT_MAP_VERSION = 1;

const EXCLUDED_PARTS = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	"coverage",
	"vendor",
	"__snapshots__",
]);

const EXCLUDED_FILE_RE = /(?:^|[\\/])[^\\/]+\.(?:generated|gen|min)\.[^\\/]+$/i;
const SOURCE_EXT_RE = /\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs|py|rs|go|java|kt|swift|cs|cpp|cc|cxx|h|hpp|rb|php)$/i;
const SIGNATURE_RE = /^(?:export\s+)?(?:declare\s+)?(?:async\s+)?(?:function|class|interface|type|enum)\b|^(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*(?::|=\s*(?:async\s*)?\()/;
const BODY_MARKER_RE = /\b(return|const|let|var)\s+.*;|=>\s*\{|\{\s*$/;

export interface BuildContextMapOptions {
	cwd: string;
	budgetTokens?: number;
	userPrompt?: string;
	mentionedFiles?: readonly string[];
	readFiles?: readonly string[];
	editedFiles?: readonly string[];
	changedFiles?: readonly string[];
	signal?: AbortSignal;
}

export interface ContextMapResult {
	rendered: string;
	usedTokens: number;
	truncated: boolean;
	files: string[];
}

interface Candidate {
	relativePath: string;
	absolutePath: string;
	score: number;
}

function normalizeRelativePath(input: string): string {
	return input.replace(/\\/g, "/").replace(/^\.\//, "");
}

function isExcluded(relativePath: string): boolean {
	const normalized = normalizeRelativePath(relativePath);
	if (!SOURCE_EXT_RE.test(normalized)) return true;
	if (EXCLUDED_FILE_RE.test(normalized)) return true;
	return normalized.split("/").some(part => EXCLUDED_PARTS.has(part));
}

function promptTerms(promptText: string | undefined): string[] {
	if (!promptText) return [];
	return Array.from(
		new Set(
			promptText
				.toLowerCase()
				.split(/[^a-z0-9_$-]+/i)
				.map(term => term.trim())
				.filter(term => term.length >= 3),
		),
	);
}

function addSeedScores(scores: Map<string, number>, paths: readonly string[] | undefined, weight: number): void {
	for (const filePath of paths ?? []) {
		const normalized = normalizeRelativePath(filePath);
		if (isExcluded(normalized)) continue;
		scores.set(normalized, (scores.get(normalized) ?? 0) + weight);
	}
}

async function collectCandidates(options: BuildContextMapOptions): Promise<Candidate[]> {
	const rootPath = path.resolve(options.cwd);
	const terms = promptTerms(options.userPrompt);
	const scores = new Map<string, number>();

	addSeedScores(scores, options.mentionedFiles, 1_000);
	addSeedScores(scores, options.editedFiles, 800);
	addSeedScores(scores, options.changedFiles, 600);
	addSeedScores(scores, options.readFiles, 500);

	let entries: Awaited<ReturnType<typeof listWorkspace>>["entries"] = [];
	try {
		entries = (
			await listWorkspace({
				path: rootPath,
				maxDepth: 6,
				hidden: false,
				gitignore: true,
				timeoutMs: 750,
			})
		).entries;
	} catch {
		entries = [];
	}

	for (const entry of entries) {
		if (options.signal?.aborted) break;
		if (entry.fileType !== FileType.File) continue;
		const relativePath = normalizeRelativePath(path.relative(rootPath, entry.path));
		if (isExcluded(relativePath)) continue;
		let score = scores.get(relativePath) ?? 0;
		const searchable = relativePath.toLowerCase();
		for (const term of terms) {
			if (searchable.includes(term)) score += 40;
		}
		if (score > 0) scores.set(relativePath, score);
	}

	return Array.from(scores.entries())
		.map(([relativePath, score]) => ({ relativePath, absolutePath: path.join(rootPath, relativePath), score }))
		.sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath))
		.slice(0, MAX_CANDIDATE_FILES);
}

function signatureFromLine(line: string): string | undefined {
	const trimmed = line.trim();
	if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) return undefined;
	if (!SIGNATURE_RE.test(trimmed)) return undefined;
	const withoutBody = trimmed
		.replace(/\s*\{.*$/, "")
		.replace(/\s*=\s*(?:async\s*)?\([^)]*\)\s*=>.*$/, "")
		.replace(/\s*=\s*function\b.*$/, "")
		.replace(/;$/, "")
		.trim();
	if (!withoutBody || BODY_MARKER_RE.test(withoutBody)) return undefined;
	return withoutBody;
}

function extractSignatures(segments: readonly SummarySegment[]): string[] {
	const signatures: string[] = [];
	const seen = new Set<string>();
	for (const segment of segments) {
		if (segment.kind !== "kept" || !segment.text) continue;
		for (const line of segment.text.split("\n")) {
			const signature = signatureFromLine(line);
			if (!signature || seen.has(signature)) continue;
			seen.add(signature);
			signatures.push(signature);
			if (signatures.length >= MAX_SIGNATURES_PER_FILE) return signatures;
		}
	}
	return signatures;
}

async function summarizeCandidate(candidate: Candidate): Promise<string[]> {
	let code: string;
	try {
		code = await Bun.file(candidate.absolutePath).text();
	} catch {
		return [];
	}
	const result = summarizeCode({
		code,
		path: candidate.absolutePath,
		minBodyLines: 2,
		minCommentLines: 2,
		unfoldUntilLines: 0,
		unfoldLimitLines: 0,
	});
	if (!result.parsed) return [];
	return extractSignatures(result.segments);
}

function renderBlock(files: Array<{ relativePath: string; signatures: string[] }>, budgetTokens: number, truncated: boolean): string {
	const body = files
		.map(file => [`${file.relativePath}`, ...file.signatures.map(signature => `- ${signature}`)].join("\n"))
		.join("\n\n");
	return `<context-map version="${CONTEXT_MAP_VERSION}" budget="${budgetTokens}" truncated="${truncated ? "true" : "false"}">\nThe map below is repository-derived orientation, not verified source of truth. Use read/search/LSP before editing.\n\n${body}\n</context-map>`;
}

export async function buildContextMap(options: BuildContextMapOptions): Promise<ContextMapResult> {
	const budgetTokens = Math.max(0, Math.floor(options.budgetTokens ?? DEFAULT_BUDGET_TOKENS));
	if (budgetTokens < MIN_BUDGET_TOKENS) return { rendered: "", usedTokens: 0, truncated: false, files: [] };

	const candidates = await collectCandidates(options);
	const renderedFiles: Array<{ relativePath: string; signatures: string[] }> = [];
	let truncated = false;

	for (const candidate of candidates) {
		if (options.signal?.aborted) break;
		if (renderedFiles.length >= MAX_RENDERED_FILES) {
			truncated = true;
			break;
		}
		const signatures = await summarizeCandidate(candidate);
		if (signatures.length === 0) continue;
		const nextFiles = [...renderedFiles, { relativePath: candidate.relativePath, signatures }];
		const nextRendered = renderBlock(nextFiles, budgetTokens, candidates.length > nextFiles.length);
		if (countTokens(nextRendered) > budgetTokens) {
			truncated = true;
			if (renderedFiles.length === 0) {
				const firstSignature = signatures[0];
				if (firstSignature) {
					const minimalFiles = [{ relativePath: candidate.relativePath, signatures: [firstSignature] }];
					const minimalRendered = renderBlock(minimalFiles, budgetTokens, true);
					if (countTokens(minimalRendered) <= budgetTokens) renderedFiles.push(minimalFiles[0]);
				}
			}
			break;
		}
		renderedFiles.push({ relativePath: candidate.relativePath, signatures });
	}

	if (renderedFiles.length === 0) return { rendered: "", usedTokens: 0, truncated, files: [] };
	const rendered = renderBlock(renderedFiles, budgetTokens, truncated || renderedFiles.length < candidates.length);
	return {
		rendered,
		usedTokens: countTokens(rendered),
		truncated: truncated || renderedFiles.length < candidates.length,
		files: renderedFiles.map(file => file.relativePath),
	};
}
```

- [ ] **Step 2: Run focused Context Map tests**

Run:

```bash
bun test packages/coding-agent/test/context-map.test.ts
```

Expected: PASS.

- [ ] **Step 3: If `FileType.File` does not match the native enum name, inspect the exported enum and adjust only that comparison**

Run this only if Step 2 fails with a `FileType` enum error:

```bash
bun test packages/coding-agent/test/workspace-tree.test.ts
```

Expected: PASS. Use `workspace-tree.ts` native list handling as the source of truth.

---

## Task 3: Static prompt rendering support

**Files:**
- Modify: `packages/coding-agent/src/system-prompt.ts`
- Modify: `packages/coding-agent/src/prompts/system/project-prompt.md`
- Modify: `packages/coding-agent/test/system-prompt-dedup.test.ts`

- [ ] **Step 1: Add failing prompt rendering tests**

Append to `packages/coding-agent/test/system-prompt-dedup.test.ts` inside the existing `describe` block that covers `buildSystemPrompt`:

```ts
it("omits context map when none is provided", async () => {
	const { systemPrompt } = await buildSystemPrompt({
		cwd: tempDir,
		contextFiles: [],
		skills: [],
		workspaceTree: { rootPath: tempDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		includeWorkspaceTree: true,
	});

	expect(systemPrompt.join("\n\n")).not.toContain("<context-map");
});

it("renders context map as a separate project prompt block when provided", async () => {
	const { systemPrompt } = await buildSystemPrompt({
		cwd: tempDir,
		contextFiles: [],
		skills: [],
		workspaceTree: { rootPath: tempDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		includeWorkspaceTree: true,
		contextMap: {
			rendered:
				'<context-map version="1" budget="1000" truncated="false">\nThe map below is repository-derived orientation, not verified source of truth. Use read/search/LSP before editing.\n\nsrc/example.ts\n- example(): void\n</context-map>',
			usedTokens: 42,
			truncated: false,
			files: ["src/example.ts"],
		},
	});
	const promptText = systemPrompt.join("\n\n");

	expect(promptText).toContain("<context-map");
	expect(promptText).toContain("src/example.ts");
	expect(promptText).toContain("- example(): void");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun test packages/coding-agent/test/system-prompt-dedup.test.ts
```

Expected: FAIL because `contextMap` is not yet a `BuildSystemPromptOptions` property and template does not render it.

- [ ] **Step 3: Extend `BuildSystemPromptOptions`**

In `packages/coding-agent/src/system-prompt.ts`, add the import near the workspace tree import:

```ts
import type { ContextMapResult } from "./context-map";
```

Add this field to `BuildSystemPromptOptions` after `includeWorkspaceTree?: boolean;`:

```ts
/** Optional compact repository orientation block. Omitted when empty. */
contextMap?: ContextMapResult;
```

In `buildSystemPrompt`, destructure it after `includeWorkspaceTree = false`:

```ts
contextMap,
```

Add it to `data` near `workspaceTree`:

```ts
contextMap,
```

- [ ] **Step 4: Render the block in the project prompt template**

In `packages/coding-agent/src/prompts/system/project-prompt.md`, insert after the `</workspace-tree>` conditional block and before `Today is ...`:

```md
{{#if contextMap.rendered}}
{{contextMap.rendered}}
{{/if}}
```

- [ ] **Step 5: Run prompt tests**

Run:

```bash
bun test packages/coding-agent/test/system-prompt-dedup.test.ts
```

Expected: PASS.

---

## Task 4: Settings and SDK wiring

**Files:**
- Modify: `packages/coding-agent/src/config/settings-schema.ts`
- Modify: `packages/coding-agent/src/sdk.ts`
- Modify later in Task 5: `packages/coding-agent/src/session/agent-session.ts`

- [ ] **Step 1: Add Context Map settings**

In `packages/coding-agent/src/config/settings-schema.ts`, add after `includeWorkspaceTree`:

```ts
"contextMap.enabled": {
	type: "boolean",
	default: false,
	ui: {
		tab: "model",
		group: "Prompt",
		label: "Context Map",
		description:
			"Inject a small task-aware map of likely relevant files and signatures before each turn. Works without CodeGraph; CodeGraph may improve this later.",
	},
},

"contextMap.budgetTokens": {
	type: "number",
	default: 1000,
	ui: {
		tab: "model",
		group: "Prompt",
		label: "Context Map Token Budget",
		description: "Hard token budget for the Context Map block. Values below 300 disable the map for that turn.",
	},
},
```

- [ ] **Step 2: Add AgentSession config fields**

In `packages/coding-agent/src/session/agent-session.ts`, import the builder near other local imports:

```ts
import { buildContextMap } from "../context-map";
```

In `AgentSessionConfig`, add near `rebuildSystemPrompt?: ...`:

```ts
/** Whether to append a task-aware Context Map before each user turn. */
contextMapEnabled?: boolean;
/** Hard token cap for the Context Map. Values below 300 suppress rendering. */
contextMapBudgetTokens?: number;
```

Add private fields near `#rebuildSystemPrompt`:

```ts
#contextMapEnabled: boolean;
#contextMapBudgetTokens: number;
```

Set them in the constructor near `#rebuildSystemPrompt` assignment:

```ts
this.#contextMapEnabled = config.contextMapEnabled ?? false;
this.#contextMapBudgetTokens = config.contextMapBudgetTokens ?? 1000;
```

- [ ] **Step 3: Pass settings from SDK**

In `packages/coding-agent/src/sdk.ts`, find the `new AgentSession({ ... })` config object and add:

```ts
contextMapEnabled: settings.get("contextMap.enabled") === true,
contextMapBudgetTokens: settings.get("contextMap.budgetTokens"),
```

- [ ] **Step 4: Run typecheck for wiring errors**

Run:

```bash
bun --cwd=packages/coding-agent run check:types
```

Expected: PASS, or only errors directly caused by Task 5 not being implemented yet. If Task 5 has not been done and typecheck fails because `#contextMapEnabled` is unused, continue to Task 5 before re-running.

---

## Task 5: Per-turn Context Map injection

**Files:**
- Modify: `packages/coding-agent/src/session/agent-session.ts`
- Test indirectly with: `packages/coding-agent/test/context-map.test.ts`, `packages/coding-agent/test/system-prompt-dedup.test.ts`, `bun --cwd=packages/coding-agent run check:types`

- [ ] **Step 1: Add a small helper to build the per-turn map**

In `packages/coding-agent/src/session/agent-session.ts`, add this private method near `#buildSystemPromptForAgentStart`:

```ts
async #buildContextMapPrompt(promptText: string): Promise<string | undefined> {
	if (!this.#contextMapEnabled) return undefined;
	try {
		const result = await buildContextMap({
			cwd: this.sessionManager.getCwd(),
			budgetTokens: this.#contextMapBudgetTokens,
			userPrompt: promptText,
		});
		return result.rendered || undefined;
	} catch (err) {
		logger.debug("Context Map build failed; continuing without it", { error: String(err) });
		return undefined;
	}
}
```

- [ ] **Step 2: Compose Context Map with memory before-agent prompt**

Replace `#buildSystemPromptForAgentStart(promptText: string)` with this logic:

```ts
async #buildSystemPromptForAgentStart(promptText: string): Promise<string[]> {
	const contextMapPrompt = await this.#buildContextMapPrompt(promptText);
	const backend = await resolveMemoryBackend(this.settings);
	if (!backend.beforeAgentStartPrompt) {
		return contextMapPrompt ? [...this.#baseSystemPrompt, contextMapPrompt] : this.#baseSystemPrompt;
	}

	try {
		const injected = await backend.beforeAgentStartPrompt(this, promptText);
		if (!injected) return contextMapPrompt ? [...this.#baseSystemPrompt, contextMapPrompt] : this.#baseSystemPrompt;

		const previousBaseSystemPrompt = this.#baseSystemPrompt;
		try {
			await this.refreshBaseSystemPrompt();
		} catch (refreshErr) {
			logger.debug("Memory backend prompt refresh after beforeAgentStartPrompt failed", {
				backend: backend.id,
				error: String(refreshErr),
			});
		}

		if (
			this.#baseSystemPrompt.length !== previousBaseSystemPrompt.length ||
			this.#baseSystemPrompt.some((part, index) => part !== previousBaseSystemPrompt[index])
		) {
			return contextMapPrompt ? [...this.#baseSystemPrompt, contextMapPrompt] : this.#baseSystemPrompt;
		}

		this.#baseSystemPromptBeforeMemoryPromotion ??= previousBaseSystemPrompt;
		const stablePrompt = [...previousBaseSystemPrompt, injected];
		this.#baseSystemPrompt = stablePrompt;
		this.agent.setSystemPrompt(stablePrompt);
		return contextMapPrompt ? [...stablePrompt, contextMapPrompt] : stablePrompt;
	} catch (err) {
		logger.debug("Memory backend beforeAgentStartPrompt failed", {
			backend: backend.id,
			error: String(err),
		});
		return contextMapPrompt ? [...this.#baseSystemPrompt, contextMapPrompt] : this.#baseSystemPrompt;
	}
}
```

This keeps the base prompt stable and appends Context Map only to the active turn.

- [ ] **Step 3: Run typecheck**

Run:

```bash
bun --cwd=packages/coding-agent run check:types
```

Expected: PASS.

---

## Task 6: Add prompt integration regression tests

**Files:**
- Modify or create: `packages/coding-agent/test/context-map.test.ts`
- Modify: `packages/coding-agent/test/system-prompt-dedup.test.ts`

- [ ] **Step 1: Add a static block budget assertion**

Append this test to `packages/coding-agent/test/context-map.test.ts`:

```ts
it("omits the map when the budget is below the minimum", async () => {
	const cwd = await makeTempDir();
	await writeProjectFile(cwd, "src/a.ts", "export function alpha(): void {}\n");

	const result = await buildContextMap({ cwd, budgetTokens: 299, userPrompt: "alpha" });

	expect(result.rendered).toBe("");
	expect(result.usedTokens).toBe(0);
	expect(result.files).toEqual([]);
});
```

- [ ] **Step 2: Add prompt-cache stability assertion**

Append this test to `packages/coding-agent/test/context-map.test.ts`:

```ts
it("does not render volatile timestamps", async () => {
	const cwd = await makeTempDir();
	await writeProjectFile(cwd, "src/stable.ts", "export function stableFeature(): void {}\n");

	const result = await buildContextMap({ cwd, budgetTokens: 500, userPrompt: "stable" });

	expect(result.rendered).not.toContain("ago");
	expect(result.rendered).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
});
```

- [ ] **Step 3: Run focused tests**

Run:

```bash
bun test packages/coding-agent/test/context-map.test.ts packages/coding-agent/test/system-prompt-dedup.test.ts
```

Expected: PASS.

---

## Task 7: Verification and cleanup

**Files:**
- All files touched above
- No changelog required unless the team wants user-visible release notes for opt-in settings

- [ ] **Step 1: Run package-local focused tests**

Run:

```bash
bun test packages/coding-agent/test/context-map.test.ts packages/coding-agent/test/system-prompt-dedup.test.ts packages/coding-agent/test/workspace-tree.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run package typecheck**

Run:

```bash
bun --cwd=packages/coding-agent run check:types
```

Expected: PASS.

- [ ] **Step 3: Run package check**

Run:

```bash
bun --cwd=packages/coding-agent run check
```

Expected: PASS.

- [ ] **Step 4: Manual smoke scenario**

Run an interactive session with `contextMap.enabled=true` and `contextMap.budgetTokens=1000`, ask for a multi-file exploratory task, and inspect the provider-facing system prompt via existing dump/debug path.

Expected:

```text
<context-map version="1" budget="1000"
The map below is repository-derived orientation, not verified source of truth.
```

Also expected:

- no function bodies inside the block;
- no generated/minified/vendor paths;
- no block when the prompt names no matching source file and no candidate scores above zero;
- normal operation when CodeGraph is absent.

- [ ] **Step 5: Optional commit only if explicitly authorized**

If and only if the user asks for a commit, create one commit for the whole feature after all verification passes.

Suggested message:

```text
feat: add opt-in context map
```

---

## Self-Review

- Spec coverage: covers independent fallback without CodeGraph, hard token cap, signature-only rendering, prompt block, activation by current prompt, exclusions, deterministic output, and verification.
- Placeholder scan: no deferred implementation steps; every task names files, code, commands, and expected results.
- Type consistency: `BuildContextMapOptions`, `ContextMapResult`, and `buildContextMap` are defined once in Task 2 and reused consistently.
- Scope check: PageRank/import graph and CodeGraph integration stay out of MVP.
