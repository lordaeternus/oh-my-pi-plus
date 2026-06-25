import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { WelcomeComponent } from "../../modes/components/welcome";
import { initTheme } from "../../modes/theme/theme";
import { getAppDisplayName, getTerminalTitlePrefix } from "../branding";
import { formatSessionTerminalTitle } from "../title-generator";

const originalDisplayName = process.env.OMP_DISPLAY_NAME;
const originalTitlePrefix = process.env.OMP_TERMINAL_TITLE_PREFIX;

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	if (originalDisplayName === undefined) delete process.env.OMP_DISPLAY_NAME;
	else process.env.OMP_DISPLAY_NAME = originalDisplayName;
	if (originalTitlePrefix === undefined) delete process.env.OMP_TERMINAL_TITLE_PREFIX;
	else process.env.OMP_TERMINAL_TITLE_PREFIX = originalTitlePrefix;
});

describe("branding", () => {
	it("uses the normal app name when no override is set", () => {
		delete process.env.OMP_DISPLAY_NAME;

		expect(getAppDisplayName()).toBe("omp");
	});

	it("uses the display override when omp-plus sets one", () => {
		process.env.OMP_DISPLAY_NAME = "Oh My Pi Plus";

		expect(getAppDisplayName()).toBe("Oh My Pi Plus");
	});

	it("uses the normal terminal prefix when no override is set", () => {
		delete process.env.OMP_TERMINAL_TITLE_PREFIX;

		expect(getTerminalTitlePrefix()).toBe("π");
	});

	it("uses the terminal prefix override when omp-plus sets one", () => {
		process.env.OMP_TERMINAL_TITLE_PREFIX = "π+";

		expect(getTerminalTitlePrefix()).toBe("π+");
	});

	it("uses the display override in the welcome title", () => {
		process.env.OMP_DISPLAY_NAME = "Oh My Pi Plus";
		const welcome = new WelcomeComponent("16.1.19", "GPT-5.5", "openai-codex");

		expect(welcome.render(100).join("\n")).toContain("Oh My Pi Plus v16.1.19");
	});

	it("uses the terminal prefix override in session titles", () => {
		process.env.OMP_TERMINAL_TITLE_PREFIX = "π+";

		expect(formatSessionTerminalTitle("tmp")).toBe("π+: tmp");
	});
});
