import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { isAdvisorTaskEndStopCandidate, shouldRunAdvisorReview } from "../modes";

function assistant(stopReason: AssistantMessage["stopReason"], content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		content,
		stopReason,
		timestamp: 1,
	};
}

describe("advisor mode gates", () => {
	it("runs every-turn on normal turns and task-end", () => {
		expect(shouldRunAdvisorReview("every-turn", "turn", false)).toBe(true);
		expect(shouldRunAdvisorReview("every-turn", "task-end", false)).toBe(true);
	});

	it("runs end-of-task only for task-end or manual review", () => {
		expect(shouldRunAdvisorReview("end-of-task", "turn", false)).toBe(false);
		expect(shouldRunAdvisorReview("end-of-task", "risk", true)).toBe(false);
		expect(shouldRunAdvisorReview("end-of-task", "task-end", false)).toBe(true);
		expect(shouldRunAdvisorReview("end-of-task", "manual", false)).toBe(true);
	});

	it("runs risk-only only when a risk is pending", () => {
		expect(shouldRunAdvisorReview("risk-only", "turn", true)).toBe(false);
		expect(shouldRunAdvisorReview("risk-only", "risk", true)).toBe(true);
		expect(shouldRunAdvisorReview("risk-only", "task-end", true)).toBe(true);
		expect(shouldRunAdvisorReview("risk-only", "risk", false)).toBe(false);
		expect(shouldRunAdvisorReview("risk-only", "task-end", false)).toBe(false);
	});

	it("runs manual only for manual review", () => {
		expect(shouldRunAdvisorReview("manual", "turn", false)).toBe(false);
		expect(shouldRunAdvisorReview("manual", "task-end", false)).toBe(false);
		expect(shouldRunAdvisorReview("manual", "manual", false)).toBe(true);
	});

	it("treats a normal final assistant stop as an end-of-task candidate", () => {
		const message = assistant("stop", [{ type: "text", text: "final answer" }]);

		expect(isAdvisorTaskEndStopCandidate(message)).toBe(true);
	});

	it("rejects intermediate and failed assistant stops as end-of-task candidates", () => {
		expect(
			isAdvisorTaskEndStopCandidate(
				assistant("toolUse", [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "x" } }]),
			),
		).toBe(false);
		expect(isAdvisorTaskEndStopCandidate(assistant("error", [{ type: "text", text: "failed" }]))).toBe(false);
		expect(isAdvisorTaskEndStopCandidate(assistant("aborted", [{ type: "text", text: "stopped" }]))).toBe(false);
		expect(isAdvisorTaskEndStopCandidate(assistant("length", [{ type: "text", text: "partial" }]))).toBe(false);
	});
});
