import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionConfig } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

interface ContextMapSessionConfig {
	contextMapEnabled: boolean;
	contextMapBudgetTokens?: number;
}

interface Harness {
	session: AgentSession;
	mock: MockModel;
	authStorage: AuthStorage;
	tempDir: TempDir;
}

const activeHarnesses: Harness[] = [];

afterEach(async () => {
	while (activeHarnesses.length > 0) {
		const harness = activeHarnesses.pop();
		await harness?.session.dispose();
		harness?.authStorage.close();
		harness?.tempDir.removeSync();
	}
});

async function writeProjectFile(cwd: string, relativePath: string, content: string): Promise<void> {
	const filePath = path.join(cwd, relativePath);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, content, "utf8");
}

async function createHarness(contextMapConfig: ContextMapSessionConfig): Promise<Harness> {
	const tempDir = TempDir.createSync("@pi-agent-session-context-map-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	authStorage.setRuntimeApiKey("mock", "test-key");

	const mock = createMockModel({ responses: [{ content: ["done"] }] });
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const settings = Settings.isolated({ "compaction.enabled": false });
	settings.setModelRole("default", `${mock.provider}/${mock.id}`);

	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model: mock.model,
			systemPrompt: ["Test"],
			tools: [],
			messages: [],
		},
		convertToLlm,
		streamFn: mock.stream,
	});

	const sessionConfig: AgentSessionConfig & ContextMapSessionConfig = {
		agent,
		sessionManager: SessionManager.inMemory(tempDir.path()),
		settings,
		modelRegistry,
		...contextMapConfig,
	};
	const session = new AgentSession(sessionConfig);
	const harness = { session, mock, authStorage, tempDir };
	activeHarnesses.push(harness);
	return harness;
}

function firstProviderSystemPrompt(mock: MockModel): string {
	const call = mock.calls[0];
	expect(call).toBeDefined();
	return call?.context.systemPrompt?.join("\n\n") ?? "";
}

describe("AgentSession context map injection", () => {
	it("adds a prompt-scoped context map for mentioned source files without leaking bodies", async () => {
		const { session, mock, tempDir } = await createHarness({ contextMapEnabled: true, contextMapBudgetTokens: 500 });
		await writeProjectFile(
			tempDir.path(),
			"src/payments.ts",
			`export interface Receipt {
	id: string;
}

export async function processPayment(userId: string, amount: number): Promise<Receipt> {
	const internalSecret = "body must not leak";
	return { id: internalSecret };
}
`,
		);

		await session.prompt("Please update src/payments.ts so payment processing handles receipts.");

		const systemPrompt = firstProviderSystemPrompt(mock);
		expect(systemPrompt).toContain("<context-map");
		expect(systemPrompt).toContain("src/payments.ts");
		expect(systemPrompt).toContain("processPayment(userId: string, amount: number): Promise<Receipt>");
		expect(systemPrompt).not.toContain("internalSecret");
		expect(systemPrompt).not.toContain("body must not leak");
		expect(session.agent.state.systemPrompt.join("\n\n")).not.toContain("<context-map");
	});

	it("does not add a context map when disabled", async () => {
		const { session, mock, tempDir } = await createHarness({ contextMapEnabled: false, contextMapBudgetTokens: 500 });
		await writeProjectFile(
			tempDir.path(),
			"src/payments.ts",
			`export function processPayment(): string {
	return "disabled context map should not leak";
}
`,
		);

		await session.prompt("Please update src/payments.ts.");

		const systemPrompt = firstProviderSystemPrompt(mock);
		expect(systemPrompt).not.toContain("<context-map");
		expect(systemPrompt).not.toContain("processPayment");
		expect(systemPrompt).not.toContain("disabled context map should not leak");
	});
});
