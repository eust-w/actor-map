import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyIR } from "../src/ir/types.ts";
import { addActor, addAssertion } from "../src/ir/store.ts";
import { exportAcceptance, exportOpenAPI, exportTools } from "../src/export/index.ts";
import { detectDrift, scanAndDrift } from "../src/scan/drift.ts";
import { scanRepo } from "../src/scan/scanner.ts";

function demoIR() {
	const ir = emptyIR("报销");
	addActor(ir, { id: "employee", name: "员工", type: "human" });
	addActor(ir, { id: "manager", name: "主管", type: "human" });
	addAssertion(ir, { from: "∅", action: "create", to: "draft", by: "employee", source: "新建" });
	addAssertion(ir, { from: "draft", action: "submit", to: "submitted", by: "employee", source: "提交" });
	addAssertion(ir, {
		from: "submitted",
		action: "approve",
		to: "approved",
		by: "manager",
		guards: ["金额 <= 5000"],
		verify: "状态变为已通过",
		source: "主管批",
	});
	return ir;
}

test("条件里的变量直接长成工具参数", () => {
	const tools = JSON.parse(exportTools(demoIR()));
	assert.equal(tools.tools.length, 3);
	const approve = tools.tools.find((t: { name: string }) => t.name === "main_approve");
	assert.equal(approve.inputSchema.properties["金额"].type, "number");
	assert.match(approve.description, /金额 <= 5000/);
});

test("OpenAPI 每个动作一个 path", () => {
	const yaml = exportOpenAPI(demoIR());
	assert.match(yaml, /^openapi: 3\.0\.3/m);
	assert.match(yaml, /\/mains\/\{id\}\/approve:/);
	assert.match(yaml, /operationId: main_approve/);
});

test("验收用例带反例", () => {
	const md = exportAcceptance(demoIR());
	assert.match(md, /\| a_003 \|/);
	assert.match(md, /金额 > 5000 时必须被拒绝/);
});

function fixtureRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "actormap-drift-"));
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(
		join(root, "src", "order.service.ts"),
		[
			'router.post("/orders/:id/submit", async (req, res) => {',
			'  if (order.status === "draft") {',
			'    order.status = "submitted";',
			"  }",
			"});",
			'router.post("/orders/:id/approve", async (req, res) => {',
			'  if (order.status === "submitted") {',
			'    order.status = "approved";',
			"  }",
			"});",
		].join("\n"),
	);
	return root;
}

test("代码多出来的迁移会被抓出来", () => {
	const root = fixtureRepo();
	try {
		const ir = emptyIR("订单");
		addActor(ir, { id: "u", name: "用户", type: "human" });
		addAssertion(ir, { from: "∅", action: "create", to: "draft", by: "u", source: "新建" });
		addAssertion(ir, { from: "draft", action: "submit", to: "submitted", by: "u", source: "提交" });

		const report = scanAndDrift(ir, root);
		assert.equal(report.onlyInCode.length, 1);
		assert.equal(report.onlyInCode[0].assertion.action, "approve");
		assert.match(report.onlyInCode[0].reason, /IR 里没有确认过/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("IR 有而代码没有的也会被点名", () => {
	const root = fixtureRepo();
	try {
		const ir = demoIR();
		addActor(ir, { id: "sweeper", name: "超时任务", type: "system", trigger: "30 天" });
		addAssertion(ir, { from: "submitted", action: "auto_close", to: "closed", by: "sweeper", source: "超时关" });

		const report = detectDrift(ir, scanRepo(root));
		assert.ok(report.onlyInIR.some((i) => i.assertion.action === "auto_close"));
		assert.ok(report.matched >= 2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
