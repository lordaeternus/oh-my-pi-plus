import { APP_NAME } from "@oh-my-pi/pi-utils";

const DEFAULT_TERMINAL_TITLE_PREFIX = "π";

export function getAppDisplayName(): string {
	const override = process.env.OMP_DISPLAY_NAME?.trim();
	return override || APP_NAME;
}

export function getTerminalTitlePrefix(): string {
	const override = process.env.OMP_TERMINAL_TITLE_PREFIX?.trim();
	return override || DEFAULT_TERMINAL_TITLE_PREFIX;
}
