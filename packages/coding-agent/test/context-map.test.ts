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

	it("renders signatures without leaking implementation bodies", async () => {
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
		expect(result.rendered).toContain("interface Receipt");
		expect(result.rendered).toContain("processPayment(userId: string, amount: number): Promise<Receipt>");
		expect(result.rendered).not.toContain("internalSecret");
		expect(result.rendered).not.toContain("body must not leak");
		expect(result.files).toContain("src/payments.ts");
	});

	it("respects the hard token budget", async () => {
		const cwd = await makeTempDir();
		for (let i = 0; i < 20; i += 1) {
			await writeProjectFile(
				cwd,
				`src/module-${String(i).padStart(2, "0")}.ts`,
				`export function module${i}Alpha(input: string): string { return input; }\nexport function module${i}Beta(input: string): string { return input; }\n`,
			);
		}

		const result = await buildContextMap({
			cwd,
			budgetTokens: 300,
			userPrompt: "module alpha beta",
		});

		expect(countTokens(result.rendered)).toBeLessThanOrEqual(300);
		expect(result.usedTokens).toBeLessThanOrEqual(300);
		expect(result.truncated).toBe(true);
	});

	it("omits the map when the budget is below the minimum useful size", async () => {
		const cwd = await makeTempDir();
		await writeProjectFile(cwd, "src/tiny.ts", "export function tinyFeature(): void {}\n");

		const result = await buildContextMap({
			cwd,
			budgetTokens: 20,
			userPrompt: "tiny feature",
			mentionedFiles: ["src/tiny.ts"],
		});

		expect(result.rendered).toBe("");
		expect(result.usedTokens).toBe(0);
		expect(result.truncated).toBe(false);
		expect(result.files).toEqual([]);
	});

	it("excludes generated vendor dist and minified files", async () => {
		const cwd = await makeTempDir();
		await writeProjectFile(cwd, "src/real.ts", "export function realFeature(): string { return 'ok'; }\n");
		await writeProjectFile(
			cwd,
			"src/client.generated.ts",
			"export function generatedFeature(): string { return 'bad'; }\n",
		);
		await writeProjectFile(cwd, "dist/bundle.ts", "export function distFeature(): string { return 'bad'; }\n");
		await writeProjectFile(cwd, "vendor/lib.ts", "export function vendorFeature(): string { return 'bad'; }\n");
		await writeProjectFile(cwd, "src/app.min.js", "export function minifiedFeature(){return 'bad'}\n");

		const result = await buildContextMap({
			cwd,
			budgetTokens: 500,
			userPrompt: "real generated vendor dist minified",
		});

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
		const renderedLines = result.rendered.split("\n");
		expect(renderedLines.findIndex(line => line.includes("src/session.ts"))).toBeLessThan(
			renderedLines.findIndex(line => line.includes("src/weak-payment-match.ts")),
		);
	});

	it("is deterministic for identical inputs", async () => {
		const cwd = await makeTempDir();
		await writeProjectFile(cwd, "src/a.ts", "export function alpha(): void {}\n");
		await writeProjectFile(cwd, "src/b.ts", "export function beta(): void {}\n");

		const first = await buildContextMap({ cwd, budgetTokens: 500, userPrompt: "alpha beta" });
		const second = await buildContextMap({ cwd, budgetTokens: 500, userPrompt: "alpha beta" });

		expect(second.rendered).toBe(first.rendered);
		expect(second.files).toEqual(first.files);
		expect(second.usedTokens).toBe(first.usedTokens);
		expect(second.truncated).toBe(first.truncated);
	});

	it("omits the map when no relevant signal scores a file", async () => {
		const cwd = await makeTempDir();
		await writeProjectFile(cwd, "src/unrelated.ts", "export function unrelatedFeature(): void {}\n");

		const result = await buildContextMap({ cwd, budgetTokens: 500, userPrompt: "plain conversation" });

		expect(result.rendered).toBe("");
		expect(result.usedTokens).toBe(0);
		expect(result.files).toEqual([]);
	});

	it("drops Python body lines from summaries", async () => {
		const cwd = await makeTempDir();
		await writeProjectFile(
			cwd,
			"src/payments.py",
			`def process_payment(user_id: str, amount: int) -> str:
    internal_secret = "python body must not leak"
    return internal_secret
`,
		);

		const result = await buildContextMap({
			cwd,
			budgetTokens: 500,
			userPrompt: "payments",
			mentionedFiles: ["src/payments.py"],
		});

		expect(result.rendered).toContain("def process_payment(user_id: str, amount: int) -> str:");
		expect(result.rendered).not.toContain("internal_secret");
		expect(result.rendered).not.toContain("python body must not leak");
		expect(result.rendered).not.toContain("return internal_secret");
	});

	it("excludes files inside generated directories", async () => {
		const cwd = await makeTempDir();
		await writeProjectFile(cwd, "src/generated/client.ts", "export function generatedClient(): void {}\n");
		await writeProjectFile(cwd, "src/real.ts", "export function realGeneratedFeature(): void {}\n");

		const result = await buildContextMap({ cwd, budgetTokens: 500, userPrompt: "generated real" });

		expect(result.rendered).toContain("src/real.ts");
		expect(result.rendered).not.toContain("src/generated/client.ts");
		expect(result.rendered).not.toContain("generatedClient");
	});

	it("keeps explicitly mentioned deep files outside workspace scan depth", async () => {
		const cwd = await makeTempDir();
		const deepPath = "a/b/c/d/e/f/g/h/i/deep.ts";
		await writeProjectFile(cwd, deepPath, "export function deepFeature(): void {}\n");

		const result = await buildContextMap({
			cwd,
			budgetTokens: 500,
			userPrompt: "plain prompt",
			mentionedFiles: [deepPath],
		});

		expect(result.files).toContain(deepPath);
		expect(result.rendered).toContain("deepFeature");
	});

	it("renders stable metadata and source-of-truth warning", async () => {
		const cwd = await makeTempDir();
		await writeProjectFile(cwd, "src/stable.ts", "export function stableFeature(): void {}\n");

		const result = await buildContextMap({ cwd, budgetTokens: 500, userPrompt: "stable" });

		expect(result.rendered).toContain('<context-map version="1" budget="500"');
		expect(result.rendered).toContain('truncated="false"');
		expect(result.rendered).toContain("not verified source of truth");
	});

	it("does not render volatile timestamps or mtime-derived output", async () => {
		const cwd = await makeTempDir();
		const filePath = path.join(cwd, "src/stable.ts");
		await writeProjectFile(cwd, "src/stable.ts", "export function stableFeature(): void {}\n");
		await fs.utimes(filePath, new Date("2025-01-02T03:04:05Z"), new Date("2025-01-02T03:04:05Z"));

		const first = await buildContextMap({
			cwd,
			budgetTokens: 500,
			userPrompt: "stable",
			mentionedFiles: ["src/stable.ts"],
		});
		await fs.utimes(filePath, new Date("2026-06-26T07:08:09Z"), new Date("2026-06-26T07:08:09Z"));
		const second = await buildContextMap({
			cwd,
			budgetTokens: 500,
			userPrompt: "stable",
			mentionedFiles: ["src/stable.ts"],
		});

		expect(second.rendered).toBe(first.rendered);
		expect(second.rendered).not.toContain("ago");
		expect(second.rendered).not.toContain("2025-01-02");
		expect(second.rendered).not.toContain("2026-06-26");
	});
});
