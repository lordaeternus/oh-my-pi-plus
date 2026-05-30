/**
 * OMP extension package roots.
 *
 * An "extension package root" is a directory configured via `extensions:` in
 * user/project `config.yml` or legacy `settings.json`, or via the
 * `--extension`/`-e` CLI flag, that points to a packaged extension on disk.
 * The package's standard sub-directories (`skills/`, `hooks/`, `tools/`,
 * `commands/`, `rules/`, `prompts/`, `.mcp.json`) are wired into discovery by
 * `omp-plugins.ts`.
 *
 * CLI-provided paths are injected via {@link injectOmpExtensionCliRoots}
 * before discovery runs; configured paths are read lazily from the same
 * project/user config scopes that `loadExtensionModules` consumes.
 *
 * @see ./omp-plugins.ts
 * @see ./builtin.ts `loadExtensionModules`
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent, logger, tryParseJson } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { readDirEntries, readFile } from "../capability/fs";
import type { LoadContext } from "../capability/types";
import { getEnabledPlugins } from "../extensibility/plugins/loader";
import { expandTilde } from "../tools/path-utils";

/** A resolved extension package directory wired into the discovery surfaces. */
export interface OmpExtensionRoot {
	/** Absolute path to the package directory. */
	path: string;
	/** Stable display name (basename of the package directory). */
	name: string;
	/** Scope from which the path was sourced. */
	level: "user" | "project";
}

interface InjectedRoot {
	path: string;
	level: "user" | "project";
}

let injectedCliRoots: InjectedRoot[] = [];

/**
 * Register CLI-provided extension package paths (e.g. from `--extension`/`-e`)
 * so the sub-discovery providers can find their sibling `skills/`, `hooks/`,
 * etc. Paths that do not resolve to a directory are silently dropped — file
 * entrypoints have no package sub-tree to scan.
 *
 * Call once during startup before any capability load. Repeated calls extend
 * the registered set; {@link clearOmpExtensionCliRoots} resets for tests.
 */
export function injectOmpExtensionCliRoots(paths: readonly string[], home: string, cwd: string): void {
	if (paths.length === 0) return;
	const expanded = paths.map(raw => {
		const tilde = expandTilde(raw, home);
		return path.isAbsolute(tilde) ? tilde : path.resolve(cwd, tilde);
	});
	const merged = new Map<string, InjectedRoot>();
	for (const root of injectedCliRoots) merged.set(root.path, root);
	for (const resolved of expanded) {
		// CLI scope mirrors how `--extension` is treated elsewhere — user-level overrides win.
		if (!merged.has(resolved)) merged.set(resolved, { path: resolved, level: "user" });
	}
	injectedCliRoots = [...merged.values()];
}

/** Drop every CLI-injected root. Tests use this between cases. */
export function clearOmpExtensionCliRoots(): void {
	injectedCliRoots = [];
}

/** Inspect currently-injected CLI roots (read-only). Exposed for diagnostics + tests. */
export function getInjectedOmpExtensionCliRoots(): readonly OmpExtensionRoot[] {
	return injectedCliRoots.map(({ path: p, level }) => ({ path: p, level, name: path.basename(p) }));
}

interface ScopeDirs {
	project: string;
	user: string;
}

function scopeDirs(ctx: LoadContext): ScopeDirs {
	// Mirror `Settings` resolution: user config lives at the active agent dir.
	// Prefer the SDK-scoped `ctx.agentDir` (populated when a caller passes
	// `agentDir` to `loadCapability` / `createAgentSession`) so non-default
	// profiles see their own sibling discovery surface; fall back to
	// `getAgentDir()` (which honors `PI_CODING_AGENT_DIR` / `PI_CONFIG_DIR`)
	// for callers that rely on the process-global agent dir.
	return {
		project: path.join(ctx.cwd, ".omp"),
		user: ctx.agentDir ?? getAgentDir(),
	};
}

function readExtensionsArray(raw: unknown): string[] | null {
	if (!Array.isArray(raw)) return null;
	return raw.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

async function readSettingsExtensions(settingsPath: string): Promise<string[] | null> {
	const content = await readFile(settingsPath);
	if (!content) return null;
	const parsed = tryParseJson<{ extensions?: unknown }>(content);
	return readExtensionsArray(parsed?.extensions);
}

interface ConfigYamlExtensions {
	exists: boolean;
	extensions: string[] | null;
}

async function readConfigYamlExtensions(configPath: string): Promise<ConfigYamlExtensions> {
	const content = await readFile(configPath);
	if (content === null) return { exists: false, extensions: null };
	try {
		const parsed = YAML.parse(content);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { exists: true, extensions: null };
		return { exists: true, extensions: readExtensionsArray((parsed as Record<string, unknown>).extensions) };
	} catch {
		return { exists: true, extensions: null };
	}
}

function resolveAgainst(raw: string, ctx: LoadContext): string {
	const tilde = expandTilde(raw, ctx.home);
	return path.isAbsolute(tilde) ? tilde : path.resolve(ctx.cwd, tilde);
}

async function isDirectory(p: string): Promise<boolean> {
	const entries = await readDirEntries(p);
	if (entries.length > 0) return true;
	// Empty directory still counts; cache returns [] for both empty and missing.
	// Disambiguate with a single stat — only hit when the cached listing is empty.
	try {
		const stat = await fs.stat(p);
		return stat.isDirectory();
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

/**
 * Resolve every configured extension package directory for the given context.
 *
 * Sources, in order of precedence:
 *
 * 1. CLI roots injected via {@link injectOmpExtensionCliRoots}
 * 2. The highest-precedence configured `extensions` array, matching
 *    `Settings` array-replacement semantics (project `config.yml`, project
 *    `settings.json`, user `config.yml`, then legacy user `settings.json`)
 * 3. Enabled plugins installed under `<plugins>/node_modules/` (e.g. via
 *    `omp install <pkg>` / `omp plugin install` / `omp plugin link`)
 *
 * Only entries that resolve to a directory on disk are returned; file
 * entrypoints contribute zero sub-discovery surface and are filtered out.
 * Installed-plugin enumeration failures (missing lockfile, unreadable
 * `package.json`, etc.) are logged at `debug` and degrade gracefully — the
 * other sources still surface.
 */
export async function listOmpExtensionRoots(ctx: LoadContext): Promise<OmpExtensionRoot[]> {
	const { project, user } = scopeDirs(ctx);
	const [
		projectSettingsExtensions,
		projectConfigExtensions,
		userSettingsExtensions,
		userConfigExtensions,
		installedPlugins,
	] = await Promise.all([
		readSettingsExtensions(path.join(project, "settings.json")),
		readConfigYamlExtensions(path.join(project, "config.yml")),
		readSettingsExtensions(path.join(user, "settings.json")),
		readConfigYamlExtensions(path.join(user, "config.yml")),
		listInstalledPluginRoots(ctx),
	]);
	const configuredExtensions =
		projectConfigExtensions.extensions !== null
			? { entries: projectConfigExtensions.extensions, level: "project" as const }
			: projectSettingsExtensions !== null
				? { entries: projectSettingsExtensions, level: "project" as const }
				: userConfigExtensions.extensions !== null
					? { entries: userConfigExtensions.extensions, level: "user" as const }
					: userConfigExtensions.exists
						? null
						: userSettingsExtensions !== null
							? { entries: userSettingsExtensions, level: "user" as const }
							: null;

	const candidates: InjectedRoot[] = [
		...injectedCliRoots,
		...(configuredExtensions?.entries.map(
			(raw): InjectedRoot => ({ path: resolveAgainst(raw, ctx), level: configuredExtensions.level }),
		) ?? []),
		...installedPlugins,
	];

	// First-seen-wins dedup preserves CLI > configured-settings > installed precedence.
	const seen = new Set<string>();
	const unique: InjectedRoot[] = [];
	for (const candidate of candidates) {
		if (seen.has(candidate.path)) continue;
		seen.add(candidate.path);
		unique.push(candidate);
	}

	const directoryFlags = await Promise.all(unique.map(c => isDirectory(c.path)));
	const roots: OmpExtensionRoot[] = [];
	for (let i = 0; i < unique.length; i++) {
		if (!directoryFlags[i]) continue;
		const { path: p, level } = unique[i];
		roots.push({ path: p, level, name: path.basename(p) });
	}
	return roots;
}

/**
 * Enumerate every enabled installed plugin's package directory so its
 * conventional `skills/`, `hooks/`, `tools/`, `commands/`, `rules/`,
 * `prompts/`, and `.mcp.json` are wired into discovery — mirrors how
 * `getAllPluginExtensionPaths` already feeds the extension factory loader.
 *
 * Marketplace and `omp plugin link` installs write to the plugin manager's
 * `node_modules` (or symlink into it) rather than to `extensions:` in
 * settings; without this branch the sub-discovery provider would still miss
 * everything those install paths produce.
 */
async function listInstalledPluginRoots(ctx: LoadContext): Promise<InjectedRoot[]> {
	try {
		const plugins = await getEnabledPlugins(ctx.cwd, { home: ctx.home });
		// Installed plugins are always user-scope; project disablement is already
		// honored by `getEnabledPlugins` via `loadProjectOverrides`.
		return plugins.map(({ path: p }) => ({ path: p, level: "user" }));
	} catch (err) {
		logger.debug("listInstalledPluginRoots: enumeration failed", { error: String(err) });
		return [];
	}
}
