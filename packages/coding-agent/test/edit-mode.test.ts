import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Settings } from "../src/config/settings";
import { resolveEditMode } from "../src/utils/edit-mode";

let originalEditVariant: string | undefined;

beforeEach(() => {
	originalEditVariant = Bun.env.PI_EDIT_VARIANT;
	delete Bun.env.PI_EDIT_VARIANT;
});

afterEach(() => {
	if (originalEditVariant === undefined) {
		delete Bun.env.PI_EDIT_VARIANT;
	} else {
		Bun.env.PI_EDIT_VARIANT = originalEditVariant;
	}
});

describe("resolveEditMode", () => {
	test("uses replace mode for glm-5.1 when no edit mode is configured", () => {
		const settings = Settings.isolated({});

		expect(
			resolveEditMode({
				settings,
				getActiveModelString: () => "zhipu/glm-5.1",
			}),
		).toBe("replace");
	});

	test("keeps explicit edit.mode above model defaults", () => {
		const settings = Settings.isolated({ "edit.mode": "hashline" });

		expect(
			resolveEditMode({
				settings,
				getActiveModelString: () => "zhipu/glm-5.1",
			}),
		).toBe("hashline");
	});

	test("keeps configured model variants above built-in model defaults", () => {
		const settings = Settings.isolated({ "edit.modelVariants": { "glm-5.1": "patch" } });

		expect(
			resolveEditMode({
				settings,
				getActiveModelString: () => "zhipu/glm-5.1",
			}),
		).toBe("patch");
	});
});
