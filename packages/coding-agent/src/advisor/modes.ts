import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { AdvisorMode } from "../config/settings-schema";

export type AdvisorReviewReason = "turn" | "task-end" | "risk" | "manual";

export function shouldRunAdvisorReview(mode: AdvisorMode, reason: AdvisorReviewReason, riskPending: boolean): boolean {
	return (
		reason === "manual" ||
		mode === "every-turn" ||
		(mode === "end-of-task" && reason === "task-end") ||
		(mode === "risk-only" && (reason === "risk" || reason === "task-end") && riskPending)
	);
}

export function isAdvisorTaskEndStopCandidate(message: AssistantMessage): boolean {
	if (message.stopReason !== "stop") return false;
	return !message.content.some(content => content.type === "toolCall");
}
