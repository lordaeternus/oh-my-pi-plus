import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { type AdvisorAgent, AdvisorRuntime, type AdvisorRuntimeHost } from "../runtime";

describe("AdvisorRuntime mode inputs", () => {
	function makeAgent(promptInputs: string[]): AdvisorAgent {
		return {
			prompt: async input => {
				promptInputs.push(input);
			},
			abort: () => {},
			reset: () => {},
			state: { messages: [] },
		};
	}

	it("omits thinking from advisor deltas when includeThinking is false", async () => {
		const promptInputs: string[] = [];
		const agent = makeAgent(promptInputs);
		const messages: AgentMessage[] = [
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "private chain" },
					{ type: "text", text: "visible answer" },
				],
				timestamp: 1,
			} as AgentMessage,
		];
		const host: AdvisorRuntimeHost = {
			snapshotMessages: () => messages,
			enqueueAdvice: () => {},
			includeThinking: () => false,
		};
		const runtime = new AdvisorRuntime(agent, host);

		runtime.onTurnEnd(messages);
		await Promise.resolve();

		expect(promptInputs[0]).toContain("visible answer");
		expect(promptInputs[0]).not.toContain("private chain");
	});

	it("reviews accumulated skipped deltas when manually triggered", async () => {
		const promptInputs: string[] = [];
		const agent = makeAgent(promptInputs);
		const messages: AgentMessage[] = [{ role: "user", content: "first", timestamp: 1 } as AgentMessage];
		const host: AdvisorRuntimeHost = {
			snapshotMessages: () => messages,
			enqueueAdvice: () => {},
		};
		const runtime = new AdvisorRuntime(agent, host);

		messages.push({ role: "assistant", content: [{ type: "text", text: "second" }], timestamp: 2 } as AgentMessage);
		runtime.onTurnEnd(messages);
		await Promise.resolve();

		expect(promptInputs[0]).toContain("first");
		expect(promptInputs[0]).toContain("second");
	});
});
