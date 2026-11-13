import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyIR } from "../src/ir/types.ts";
import { addActor, addAssertion, loadIR, resolveIRPath, saveIR } from "../src/ir/store.ts";
import { buildSystemPrompt, runTurn, TOOL_DECLARATIONS } from "../src/server/agent.ts";
import { createGenerate, resolveLlmConfig } from "../src/server/llm.ts";
import type { Generate, GenerateInput } from "../src/server/llm.ts";
import { handleApi } from "../src/server/app.ts";

function workspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "actormap-agent-"));
	mkdirSync(join(dir, ".actormap"), { recursive: true });
	const ir = emptyIR("报销系统");
	addActor(ir, { id: "employee", name: "员工", type: "human" });
	addAssertion(ir, { from: "∅", action: "create", to: "draft", by: "employee", source: "员工新建" });
	saveIR(resolveIRPath(dir), ir);
	return dir;
}

/** 第一轮返回一个工具调用，第二轮返回文本 —— 模拟真实的 agent 循环 */
function scriptedGenerate(calls: Array<GenerateInput>): Generate {
	return async (input) => {
		calls.push(input);
		if (calls.length === 1) {
			return {
				text: "",
				calls: [
					{
						name: "ir_add_assertion",
						args: { from: "draft", action: "submit", to: "submitted", by: "employee", source: "填完点提交" },
					},
				],
			};
		}
		return { text: "记下了：草稿 →提交→ 待审批。主管批的时候有金额上限吗？", calls: [] };
	};
}

test("system prompt 每轮都带上当前 IR 和缺口", () => {
	const ir = emptyIR("报销");
	addActor(ir, { id: "employee", name: "员工", type: "human" });
	addAssertion(ir, { from: "∅", action: "create", to: "draft", by: "employee", source: "新建" });
	const prompt = buildSystemPrompt(ir);
	assert.match(prompt, /报销/);
	assert.match(prompt, /employee（员工，human）/);
	assert.match(prompt, /∅ --create--> draft/);
	assert.match(prompt, /待解决的问题/);
	assert.match(prompt, /一次只问一个问题/);
});

test("模型调工具 → 真写进 IR → 再把结果回给模型", async () => {
	const dir = workspace();
	try {
		const calls: GenerateInput[] = [];
		const result = await runTurn(dir, [{ role: "user", text: "员工提交后进入待审批" }], scriptedGenerate(calls));

		assert.match(result.reply, /待审批/);
		assert.equal(result.events.length, 1);
		assert.equal(result.events[0].name, "ir_add_assertion");
		assert.equal(result.events[0].ok, true);

		const ir = loadIR(resolveIRPath(dir));
		assert.ok(ir.assertions.some((a) => a.action === "submit" && a.from === "draft"));

		// 第二轮请求里应当带上了 functionResponse
		const second = JSON.stringify(calls[1].contents);
		assert.match(second, /functionResponse/);
		assert.match(second, /已记录 a_/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("工具失败的原因原样回喂给模型，而不是静默吞掉", async () => {
	const dir = workspace();
	try {
		const calls: GenerateInput[] = [];
		const generate: Generate = async (input) => {
			calls.push(input);
			if (calls.length === 1) {
				return {
					text: "",
					calls: [{ name: "ir_add_assertion", args: { from: "draft", action: "x", to: "y", by: "ghost" } }],
				};
			}
			return { text: "没登记这个角色，我先登记一下。", calls: [] };
		};
		const result = await runTurn(dir, [{ role: "user", text: "让鬼来批" }], generate);
		assert.equal(result.events[0].ok, false);
		assert.match(result.events[0].detail, /未登记/);
		assert.match(JSON.stringify(calls[1].contents), /未登记/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("工具调用死循环有上限", async () => {
	const dir = workspace();
	try {
		const generate: Generate = async () => ({
			text: "",
			calls: [{ name: "ir_validate", args: {} }],
		});
		const result = await runTurn(dir, [{ role: "user", text: "一直调" }], generate, { maxSteps: 3 });
		assert.equal(result.events.length, 3);
		assert.match(result.reply, /上限/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("工具声明覆盖三个动作，且参数是 JSON Schema", () => {
	const names = TOOL_DECLARATIONS.map((t) => t.name);
	assert.deepEqual(names.sort(), ["ir_add_actor", "ir_add_assertion", "ir_validate"]);
	for (const tool of TOOL_DECLARATIONS) {
		assert.equal(tool.parameters.type, "OBJECT");
		assert.ok(tool.description.length > 10);
	}
});

test("模型配置优先用 ACTORMAP_*，其次 Gemini 环境变量", () => {
	const custom = resolveLlmConfig({ ACTORMAP_LLM_BASE: "http://x", ACTORMAP_LLM_KEY: "k", ACTORMAP_LLM_MODEL: "m" });
	assert.deepEqual(custom, { base: "http://x", key: "k", model: "m" });

	const gemini = resolveLlmConfig({ GOOGLE_GEMINI_BASE_URL: "http://g/", GEMINI_API_KEY: "k2", GEMINI_MODEL: "g2" });
	assert.deepEqual(gemini, { base: "http://g", key: "k2", model: "g2" });

	assert.equal(resolveLlmConfig({}), undefined);
});

test("请求体把工具包进 functionDeclarations，并过滤掉 thought", async () => {
	let sent: Record<string, unknown> | undefined;
	const fetcher = (async (_url: string, init?: RequestInit) => {
		sent = JSON.parse(String(init?.body));
		return new Response(
			JSON.stringify({
				candidates: [{ content: { parts: [{ text: "想一下", thought: true }, { text: "好的" }] } }],
			}),
			{ status: 200 },
		);
	}) as unknown as typeof fetch;

	const generate = createGenerate({ base: "http://x", key: "k", model: "m" }, fetcher);
	const reply = await generate({ system: "s", contents: [], tools: TOOL_DECLARATIONS });

	assert.equal(reply.text, "好的");
	const tools = (sent as { tools: Array<{ functionDeclarations: unknown[] }> }).tools;
	assert.equal(tools[0].functionDeclarations.length, 3);
});

test("POST /api/chat 走注入的模型，并把新状态一起返回", async () => {
	const dir = workspace();
	try {
		const res = await handleApi(
			{ method: "POST", path: "/api/chat", body: { message: "员工提交后进入待审批", history: [] } },
			dir,
			{ generate: scriptedGenerate([]) },
		);
		assert.equal(res.status, 200);
		const body = res.body as { reply: string; events: unknown[]; state: { assertions: unknown[] } };
		assert.match(body.reply, /待审批/);
		assert.equal(body.events.length, 1);
		assert.equal(body.state.assertions.length, 2, "状态应当在同一次响应里更新");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("POST /api/chat 缺 message 时 400", async () => {
	const dir = workspace();
	try {
		const res = await handleApi({ method: "POST", path: "/api/chat", body: {} }, dir, { generate: scriptedGenerate([]) });
		assert.equal(res.status, 400);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("没有模型时 /api/chat/status 明确告诉怎么配", async () => {
	const res = await handleApi({ method: "GET", path: "/api/chat/status", body: {} }, workspace());
	const body = res.body as { available: boolean; hint?: string; model?: string };
	if (body.available) {
		assert.ok(body.model);
	} else {
		assert.match(body.hint ?? "", /ACTORMAP_LLM_BASE/);
	}
});
