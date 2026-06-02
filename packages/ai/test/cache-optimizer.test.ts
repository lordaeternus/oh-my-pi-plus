import { describe, expect, it } from "bun:test";
import { buildCacheAlignmentPadding, type CachePrefixSegment, calculateCacheHitRate } from "../src/cache-optimizer";
import type { Model } from "../src/types";

const model: Model<"openai-responses"> = {
	id: "gpt-test",
	name: "GPT Test",
	api: "openai-responses",
	provider: "openai",
	input: ["text"],
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4_096,
};

function countCharacters(segments: readonly CachePrefixSegment[]): number {
	return segments.reduce((total, segment) => total + segment.text.length, 0);
}

describe("CacheOptimizer", () => {
	it("pads a prefix segment to the next provider cache block boundary", () => {
		const segments: CachePrefixSegment[] = [{ kind: "system", text: "stable" }];

		const padding = buildCacheAlignmentPadding({
			model,
			segments,
			segmentIndex: 0,
			options: { blockSize: 8, paddingText: ".", countTokens: countCharacters },
		});

		expect(padding).toBe("..");
	});

	it("does not pad when explicitly disabled", () => {
		const segments: CachePrefixSegment[] = [{ kind: "system", text: "stable" }];

		const padding = buildCacheAlignmentPadding({
			model,
			segments,
			segmentIndex: 0,
			options: { enabled: false, blockSize: 8, paddingText: ".", countTokens: countCharacters },
		});

		expect(padding).toBe("");
	});

	it("does not pad without an explicit tokenizer", () => {
		const segments: CachePrefixSegment[] = [{ kind: "system", text: "stable" }];

		const padding = buildCacheAlignmentPadding({
			model,
			segments,
			segmentIndex: 0,
			options: { enabled: true, blockSize: 8, paddingText: "." },
		});

		expect(padding).toBe("");
	});

	it("computes cache hit rate from normalized usage counters", () => {
		expect(calculateCacheHitRate({ input: 25, cacheRead: 75 })).toBe(0.75);
		expect(calculateCacheHitRate({ input: 0, cacheRead: 0 })).toBeUndefined();
	});
});
