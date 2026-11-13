/**
 * 工具层的端到端测试：不经过模型，直接调工具背后那层。
 * 这层跑通，就说明"聊 5 轮 → 落断言 → 出清单"只差一个会问问题的模型。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addActorTool, addAssertionTool, changeTool, mapSummary, validateTool } from "../src/extension/handlers.ts";

function workspace(): string {
	return mkdtempSync(join(tmpdir(), "actormap-ws-"));
}

test("五个工具串起来能走完一轮完整访谈", () => {
	const cwd = workspace();
	try {
		addActorTool({ id: "employee", name: "员工", type: "human" }, cwd);
		addActorTool({ id: "manager", name: "主管", type: "human" }, cwd);
		addActorTool({ id: "sweeper", name: "超时关单", type: "system", trigger: "30 天未处理" }, cwd);

		addAssertionTool({ from: "∅", action: "create", to: "draft", by: "employee", source: "员工新建" }, cwd);
		addAssertionTool({ from: "draft", action: "submit", to: "submitted", by: "employee", guards: ["金额 > 0"], source: "提交" }, cwd);
		addAssertionTool({ from: "submitted", action: "approve", to: "approved", by: "manager", guards: ["金额 <= 5000"], source: "主管批" }, cwd);
		addAssertionTool({ from: "submitted", action: "auto_close", to: "closed", by: "sweeper", guards: ["now - submitted_at > 30d"], source: "超时关单" }, cwd);

		const validated = validateTool({ acknowledge_terminal: ["approved"] }, cwd);
		assert.match(validated.text, /0 错误/);

		assert.ok(existsSync(join(cwd, ".actormap", "ir.json")));
		assert.ok(existsSync(join(cwd, ".actormap", "map.md")));
		assert.ok(existsSync(join(cwd, ".actormap", "map.html")));

		const ir = JSON.parse(readFileSync(join(cwd, ".actormap", "ir.json"), "utf8"));
		assert.equal(ir.assertions.length, 4);
		assert.equal(ir.actors.length, 3);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("工具边界挡住未登记的角色", () => {
	const cwd = workspace();
	try {
		assert.throws(
			() => addAssertionTool({ from: "draft", action: "submit", to: "submitted", by: "ghost" }, cwd),
			/未登记/,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("改需求后清单和地图一起更新", () => {
	const cwd = workspace();
	try {
		addActorTool({ id: "employee", name: "员工", type: "human" }, cwd);
		addActorTool({ id: "manager", name: "主管", type: "human" }, cwd);
		addAssertionTool({ from: "∅", action: "create", to: "draft", by: "employee", source: "新建" }, cwd);
		addAssertionTool({ from: "draft", action: "submit", to: "submitted", by: "employee", source: "提交" }, cwd);
		addAssertionTool({ from: "submitted", action: "approve", to: "approved", by: "manager", source: "批" }, cwd);

		const result = changeTool(
			{
				reason: "主管也可以驳回",
				changes: [
					{
						op: "add",
						assertion: {
							entity: "main",
							from: "submitted",
							action: "reject",
							to: "draft",
							by: "manager",
							guards: [],
							verify: "",
							source: "可以驳回",
							status: "confirmed",
						},
					},
				],
			},
			cwd,
		);
		assert.match(result.text, /cs_001/);
		assert.match(result.text, /后续动作/);

		const ir = JSON.parse(readFileSync(join(cwd, ".actormap", "ir.json"), "utf8"));
		assert.equal(ir.changesets.length, 1);
		assert.match(readFileSync(join(cwd, ".actormap", "map.md"), "utf8"), /reject/);
		assert.match(readFileSync(join(cwd, ".actormap", "map.html"), "utf8"), /reject/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/map 汇总能读出现有 IR", () => {
	const cwd = workspace();
	try {
		addActorTool({ id: "u", name: "用户", type: "human" }, cwd);
		addAssertionTool({ from: "∅", action: "create", to: "draft", by: "u", source: "建" }, cwd);
		const summary = mapSummary(cwd);
		assert.match(summary, /断言 1/);
		assert.match(summary, /map\.html/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("导出三份投影 + 漂移检测都能从工具层调通", async () => {
	const { exportTool, driftTool } = await import("../src/extension/handlers.ts");
	const cwd = workspace();
	try {
		addActorTool({ id: "u", name: "用户", type: "human" }, cwd);
		addAssertionTool({ from: "∅", action: "create", to: "draft", by: "u", source: "建" }, cwd);
		addAssertionTool({ from: "draft", action: "submit", to: "submitted", by: "u", source: "提交" }, cwd);

		const exported = exportTool({}, cwd);
		assert.match(exported.text, /tools\.json/);
		assert.ok(existsSync(join(cwd, ".actormap", "export", "openapi.yaml")));
		assert.ok(existsSync(join(cwd, ".actormap", "export", "acceptance.md")));

		const drift = driftTool({ path: cwd }, cwd);
		assert.match(drift.text, /IR 独有/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
