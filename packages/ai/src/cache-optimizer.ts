import type { Api, Model } from "./types";

/**
 * Provider cache block sizes used when callers do not override alignment.
 *
 * - `anthropic`: 128-token blocks per Anthropic prompt-caching docs.
 * - `openaiResponses`: 128-token blocks. OpenAI prompt caching only reuses
 *   prefixes in 128-token increments after a 1024-token floor — the smaller
 *   64-token chunk boundary is not a cacheable reuse boundary.
 */
export const CACHE_OPTIMIZER_BLOCK_TOKENS = {
	anthropic: 128,
	openaiResponses: 128,
} as const;

/** A stable-prefix fragment as seen by provider-specific cache alignment. */
export interface CachePrefixSegment {
	readonly kind: "tool" | "system" | "message";
	readonly role?: string;
	readonly text: string;
}

/** Counts provider tokens for the complete prefix represented by ordered segments. */
export type CacheTokenCounter = (segments: readonly CachePrefixSegment[], model: Model<Api>) => number;

/** Prefix-cache alignment controls. Providing a token counter enables alignment unless `enabled` is false. */
export interface CacheOptimizerOptions {
	/** Disable block-boundary padding while preserving the rest of the option object. Default: true. */
	readonly enabled?: boolean;
	/** Provider/model tokenizer callback for the cumulative prefix being aligned. */
	readonly countTokens?: CacheTokenCounter;
	/** Override provider block size; defaults to 128-token Anthropic and OpenAI Responses cache increments. */
	readonly blockSize?: number;
	/** Semantically inert text appended to the block being aligned. Defaults to a newline. */
	readonly paddingText?: string;
	/** Maximum token increase allowed per aligned breakpoint. Defaults to one block minus one token. */
	readonly maxPaddingTokens?: number;
}

interface CacheOptimizerPlan {
	readonly countTokens: CacheTokenCounter;
	readonly blockSize: number;
	readonly paddingText: string;
	readonly maxPaddingTokens: number;
}

/** Returns the provider default cache block size for a model. */
export function getCacheOptimizerBlockSize(model: Model<Api>): number | undefined {
	if (model.api === "anthropic-messages") return CACHE_OPTIMIZER_BLOCK_TOKENS.anthropic;
	if (model.api === "openai-responses") return CACHE_OPTIMIZER_BLOCK_TOKENS.openaiResponses;
	return undefined;
}

function buildCacheOptimizerPlan(
	options: CacheOptimizerOptions | undefined,
	defaultBlockSize: number | undefined,
): CacheOptimizerPlan | undefined {
	if (options?.enabled === false || !options?.countTokens) return undefined;
	const resolvedBlockSize = options.blockSize ?? defaultBlockSize;
	if (resolvedBlockSize === undefined || !Number.isSafeInteger(resolvedBlockSize) || resolvedBlockSize <= 1) {
		return undefined;
	}
	const paddingText = options.paddingText ?? "\n";
	if (paddingText.length === 0) return undefined;
	const maxPaddingTokens = options.maxPaddingTokens ?? resolvedBlockSize - 1;
	if (!Number.isSafeInteger(maxPaddingTokens) || maxPaddingTokens <= 0) return undefined;
	return { countTokens: options.countTokens, blockSize: resolvedBlockSize, paddingText, maxPaddingTokens };
}

function withSegmentText(
	segments: readonly CachePrefixSegment[],
	segmentIndex: number,
	text: string,
): CachePrefixSegment[] {
	return segments.map((segment, index) => (index === segmentIndex ? { ...segment, text } : segment));
}

/**
 * Pads one mutable prefix segment until the cumulative provider token count lands
 * exactly on a cache block boundary. Returns the appended padding, if any.
 */
export function buildCacheAlignmentPadding(args: {
	readonly options: CacheOptimizerOptions | undefined;
	readonly model: Model<Api>;
	readonly segments: readonly CachePrefixSegment[];
	readonly segmentIndex: number;
}): string {
	const plan = buildCacheOptimizerPlan(args.options, getCacheOptimizerBlockSize(args.model));
	if (!plan) return "";
	const segment = args.segments[args.segmentIndex];
	if (!segment) return "";
	const initialTokens = plan.countTokens(args.segments, args.model);
	if (!Number.isFinite(initialTokens) || initialTokens <= 0 || initialTokens % plan.blockSize === 0) return "";
	let padding = "";
	for (let appendedUnits = 0; appendedUnits < plan.maxPaddingTokens; appendedUnits++) {
		padding += plan.paddingText;
		const candidateSegments = withSegmentText(args.segments, args.segmentIndex, segment.text + padding);
		const candidateTokens = plan.countTokens(candidateSegments, args.model);
		if (!Number.isFinite(candidateTokens) || candidateTokens <= initialTokens) continue;
		if (candidateTokens - initialTokens > plan.maxPaddingTokens) return "";
		if (candidateTokens % plan.blockSize === 0) return padding;
	}
	return "";
}

/** Computes cache hit-rate from normalized provider usage counters. */
export function calculateCacheHitRate(usage: {
	readonly input?: number;
	readonly cacheRead?: number;
}): number | undefined {
	const input = usage.input ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	const total = input + cacheRead;
	if (total <= 0) return undefined;
	return cacheRead / total;
}
