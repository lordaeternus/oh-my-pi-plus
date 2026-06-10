import { $env } from "@oh-my-pi/pi-utils";

export type EditMode = "replace" | "patch" | "hashline" | "apply_patch";

export const DEFAULT_EDIT_MODE: EditMode = "hashline";

const EDIT_MODE_IDS = {
	apply_patch: "apply_patch",
	hashline: "hashline",
	patch: "patch",
	replace: "replace",
} as const satisfies Record<string, EditMode>;

export const EDIT_MODES = Object.keys(EDIT_MODE_IDS) as EditMode[];

type DefaultModelEditVariant = {
	pattern: string;
	mode: EditMode;
};

const DEFAULT_MODEL_EDIT_VARIANTS: readonly DefaultModelEditVariant[] = [{ pattern: "glm-5.1", mode: "replace" }];

function getDefaultEditVariantForModel(model: string | undefined): EditMode | null {
	if (!model) return null;
	for (const variant of DEFAULT_MODEL_EDIT_VARIANTS) {
		if (model.includes(variant.pattern)) return variant.mode;
	}
	return null;
}

export function normalizeEditMode(mode?: string | null): EditMode | undefined {
	if (!mode) return undefined;
	return EDIT_MODE_IDS[mode as keyof typeof EDIT_MODE_IDS];
}

export interface EditModeSettingsLike {
	get(key: "edit.mode"): unknown;
	isConfigured?(key: "edit.mode"): boolean;
	getEditVariantForModel?(model: string | undefined): EditMode | null;
}

export interface EditModeSessionLike {
	settings: EditModeSettingsLike;
	getActiveModelString?: () => string | undefined;
}

export function resolveEditMode(session: EditModeSessionLike): EditMode {
	const activeModel = session.getActiveModelString?.();
	const modelVariant = session.settings.getEditVariantForModel?.(activeModel);
	if (modelVariant) return modelVariant;

	const envMode = normalizeEditMode($env.PI_EDIT_VARIANT);
	if (envMode) return envMode;

	const settingsMode = normalizeEditMode(String(session.settings.get("edit.mode") ?? ""));
	if (settingsMode && session.settings.isConfigured?.("edit.mode")) return settingsMode;

	const defaultModelVariant = getDefaultEditVariantForModel(activeModel);
	if (defaultModelVariant) return defaultModelVariant;

	return settingsMode ?? DEFAULT_EDIT_MODE;
}
