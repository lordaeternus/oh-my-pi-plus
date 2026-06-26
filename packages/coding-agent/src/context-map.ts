import * as path from "node:path";
import { countTokens } from "@oh-my-pi/pi-agent-core";
import { FileType, type GlobMatch, listWorkspace, type SummaryResult, summarizeCode } from "@oh-my-pi/pi-natives";

const MIN_BUDGET_TOKENS = 300;
const MAX_CANDIDATE_FILES = 80;
const SOURCE_EXTENSIONS: Record<string, true> = {
	".c": true,
	".cc": true,
	".cpp": true,
	".cs": true,
	".css": true,
	".go": true,
	".h": true,
	".hpp": true,
	".java": true,
	".js": true,
	".jsx": true,
	".kt": true,
	".mjs": true,
	".py": true,
	".rs": true,
	".swift": true,
	".ts": true,
	".tsx": true,
};
const SKIP_DIRS: Record<string, true> = {
	".git": true,
	".next": true,
	build: true,
	coverage: true,
	dist: true,
	generated: true,
	node_modules: true,
	out: true,
	target: true,
	vendor: true,
};
const SIGNATURE_LINE_RE =
	/^\s*(?:export\s+)?(?:(?:async\s+)?function|class|interface|type|enum|const\s+\w+\s*(?::|=\s*(?:async\s*)?\())\b|^\s*(?:async\s+)?def\s+\w+|^\s*(?:async\s+)?[A-Za-z_$][\w$]*\s*\([^)]*\)\s*(?::[^=].*)?$/u;

export interface BuildContextMapOptions {
	cwd: string;
	budgetTokens?: number;
	userPrompt?: string;
	mentionedFiles?: readonly string[];
	editedFiles?: readonly string[];
	changedFiles?: readonly string[];
	readFiles?: readonly string[];
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface ContextMapResult {
	rendered: string;
	usedTokens: number;
	files: string[];
	truncated: boolean;
}

interface Candidate {
	path: string;
	score: number;
}

export async function buildContextMap(options: BuildContextMapOptions): Promise<ContextMapResult> {
	const budgetTokens = options.budgetTokens ?? 1000;
	if (budgetTokens < MIN_BUDGET_TOKENS) return emptyResult();
	const rootPath = path.resolve(options.cwd);
	const candidates = await discoverCandidates(rootPath, options);
	if (candidates.length === 0) return emptyResult();

	const blocks: string[] = [];
	const files: string[] = [];
	let truncated = false;

	for (const candidate of candidates) {
		if (options.signal?.aborted) break;
		const summary = await summarizeCandidate(rootPath, candidate.path);
		if (!summary) continue;

		const signatures = renderSignatures(summary);
		if (signatures.length === 0) continue;

		const block = `<file path="${escapeAttribute(candidate.path)}">\n${signatures}\n</file>`;
		const nextRendered = renderBlocks([...blocks, block], budgetTokens, true);
		if (countTokens(nextRendered) > budgetTokens) {
			truncated = true;
			break;
		}

		blocks.push(block);
		files.push(candidate.path);
	}

	if (blocks.length === 0) return emptyResult();

	const rendered = renderBlocks(blocks, budgetTokens, truncated || files.length < candidates.length);
	return {
		rendered,
		usedTokens: countTokens(rendered),
		files,
		truncated: truncated || files.length < candidates.length,
	};
}

async function discoverCandidates(rootPath: string, options: BuildContextMapOptions): Promise<Candidate[]> {
	let entries: GlobMatch[];
	try {
		const result = await listWorkspace({
			path: rootPath,
			maxDepth: 8,
			hidden: false,
			gitignore: true,
			timeoutMs: options.timeoutMs,
		});
		entries = result.entries;
	} catch {
		return [];
	}

	const directPaths = collectDirectPaths(rootPath, options);
	const promptTerms = promptTokens(options.userPrompt ?? "");
	const candidateScores = new Map<string, number>();

	for (const directPath of directPaths) {
		if (isUsablePath(directPath)) candidateScores.set(directPath, 10_000);
	}

	for (const entry of entries) {
		if (options.signal?.aborted) break;
		if (entry.fileType !== FileType.File) continue;
		const relativePath = normalizeRelativePath(entry.path);
		if (!isUsablePath(relativePath)) continue;

		const score = (candidateScores.get(relativePath) ?? 0) + scorePromptPath(relativePath, promptTerms);
		if (score > 0) candidateScores.set(relativePath, score);
	}

	return Array.from(candidateScores.entries())
		.map(([candidatePath, score]) => ({ path: candidatePath, score }))
		.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
		.slice(0, MAX_CANDIDATE_FILES);
}

function collectDirectPaths(rootPath: string, options: BuildContextMapOptions): Set<string> {
	const paths = new Set<string>();
	for (const group of [options.mentionedFiles, options.editedFiles, options.changedFiles, options.readFiles]) {
		for (const filePath of group ?? []) paths.add(normalizeInputPath(rootPath, filePath));
	}
	return paths;
}

function promptTokens(prompt: string): string[] {
	return prompt
		.toLowerCase()
		.split(/[^a-z0-9]+/u)
		.filter(token => token.length >= 3);
}

function scorePromptPath(filePath: string, terms: readonly string[]): number {
	if (terms.length === 0) return 0;
	const lowerPath = filePath.toLowerCase();
	let score = 0;
	for (const term of terms) {
		if (lowerPath.includes(term)) score += 10;
	}
	return score;
}

async function summarizeCandidate(rootPath: string, relativePath: string): Promise<SummaryResult | null> {
	try {
		const absolutePath = path.join(rootPath, relativePath);
		const code = await Bun.file(absolutePath).text();
		const summary = summarizeCode({ code, path: absolutePath, minBodyLines: 1, minCommentLines: 1 });
		return summary.parsed ? summary : null;
	} catch {
		return null;
	}
}

function renderSignatures(summary: SummaryResult): string {
	const lines: string[] = [];
	const seen = new Set<string>();
	for (const segment of summary.segments) {
		if (segment.kind !== "kept" || !segment.text) continue;
		for (const line of segment.text.split("\n")) {
			const signature = signatureFromLine(line);
			if (!signature || seen.has(signature)) continue;
			seen.add(signature);
			lines.push(signature);
		}
	}
	return lines.join("\n");
}

function signatureFromLine(line: string): string | undefined {
	const trimmed = stripInlineBody(line).trimEnd();
	if (!SIGNATURE_LINE_RE.test(trimmed)) return undefined;
	return trimmed;
}

function stripInlineBody(line: string): string {
	const open = line.indexOf("{");
	if (open < 0) return line;
	const before = line.slice(0, open);
	if (!/\b(function|class|interface|type|enum|const|if|for|while|switch|catch|try|else)\b|=>/u.test(before))
		return line;
	return before.trimEnd();
}

function isUsablePath(filePath: string): boolean {
	const lowerPath = filePath.toLowerCase();
	const parts = lowerPath.split("/");
	if (parts.some(part => SKIP_DIRS[part])) return false;
	const basename = parts[parts.length - 1] ?? "";
	if (basename.includes(".min.")) return false;
	if (/\.(generated|gen|bundle)\./u.test(basename)) return false;
	return SOURCE_EXTENSIONS[path.posix.extname(lowerPath)] === true;
}

function normalizeRelativePath(filePath: string): string {
	return filePath.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function normalizeInputPath(rootPath: string, filePath: string): string {
	return normalizeRelativePath(path.isAbsolute(filePath) ? path.relative(rootPath, filePath) : filePath);
}

function renderBlocks(blocks: readonly string[], budgetTokens: number, truncated: boolean): string {
	return `<context-map version="1" budget="${budgetTokens}" truncated="${truncated ? "true" : "false"}">\nGuidance only; not verified source of truth. Use tools before editing.\n${blocks.join("\n")}\n</context-map>`;
}

function escapeAttribute(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function emptyResult(): ContextMapResult {
	return { rendered: "", usedTokens: 0, files: [], truncated: false };
}
