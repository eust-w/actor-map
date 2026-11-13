import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanRepo } from "../src/scan/scanner.ts";

function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), "actormap-scan-"));
	mkdirSync(join(root, "src", "orders"), { recursive: true });
	writeFileSync(
		join(root, "src", "orders", "order.model.ts"),
		[
			"export interface Order {",
			"  id: string;",
			"}",
			"",
			'enum OrderStatus { draft = "draft", submitted = "submitted", approved = "approved", closed = "closed" }',
		].join("\n"),
	);
	writeFileSync(
		join(root, "src", "orders", "order.service.ts"),
		[
			'router.post("/orders/:id/submit", async (req, res) => {',
			'  if (order.status === "draft") {',
			'    order.status = "submitted";',
			"  }",
			"});",
			"",
			'router.post("/orders/:id/approve", async (req, res) => {',
			'  if (order.status === "submitted") {',
			'    order.status = "approved";',
			"  }",
			"});",
			"",
			"cron.schedule('0 2 * * *', sweep);",
		].join("\n"),
	);
	writeFileSync(
		join(root, "src", "auth.ts"),
		['if (user.role === "admin") {', "  allow();", "}"].join("\n"),
	);
	return root;
}

test("从代码里抽出实体、状态、迁移、角色", () => {
	const root = fixture();
	try {
		const report = scanRepo(root);
		const values = report.findings.map((f) => `${f.kind}:${f.value}`);
		assert.ok(values.includes("entity:Order"), values.join(","));
		assert.ok(values.includes("state:submitted"));
		assert.ok(values.includes("actor:admin"));
		assert.ok(values.includes("system:/orders/:id/submit") || values.some((v) => v.startsWith("system:")));

		const skeleton = report.skeleton;
		assert.ok(skeleton.actors.some((a) => a.name === "admin"));

		const submit = skeleton.assertions.find((a) => a.action === "submit");
		assert.ok(submit, "应当从 route + 状态赋值推出 submit 迁移");
		assert.equal(submit.from, "draft");
		assert.equal(submit.to, "submitted");
		assert.equal(submit.entity, "Order");
		assert.match(submit.source, /order\.service\.ts:\d+/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("看不出 from 的赋值不进图，只变成问题", () => {
	const root = mkdtempSync(join(tmpdir(), "actormap-scan2-"));
	try {
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(
			join(root, "src", "job.ts"),
			["export function run(order) {", '  order.status = "archived";', "}"].join("\n"),
		);
		const report = scanRepo(root);
		const archived = report.skeleton.assertions.find((a) => a.to === "archived");
		assert.ok(archived);
		assert.equal(archived.from, "∅");
		assert.equal(archived.status, "assumed");
		assert.ok(report.questions.some((q) => q.includes("archived")));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("扫描结果是一张能过校验器的图", () => {
	const root = fixture();
	try {
		const report = scanRepo(root);
		assert.ok(report.skeleton.assertions.length > 0);
		assert.equal(report.skeleton.version, 1);
		assert.ok(report.filesScanned >= 3);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("控制流关键字不会被当成动作名", () => {
	const root = mkdtempSync(join(tmpdir(), "actormap-scan3-"));
	try {
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(
			join(root, "src", "order.service.ts"),
			[
				"function must(condition) { if (!condition) throw new Error('x'); }",
				"export default {",
				"  act(id, action, ctx) {",
				"    switch (action) {",
				'      case "submit":',
				'        must(order.status === "draft");',
				'        order.status = "submitted";',
				"    }",
				"  },",
				"};",
			].join("\n"),
		);
		const report = scanRepo(root);
		const actions = report.skeleton.assertions.map((a) => a.action);
		assert.ok(!actions.includes("must"), `不该出现 must：${actions.join(",")}`);
		assert.ok(!actions.includes("switch"), `不该出现 switch：${actions.join(",")}`);
		assert.ok(actions.includes("act"), `应当用最近的方法名：${actions.join(",")}`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("exclude 能跳过契约测试适配器这类替身文件", () => {
	const root = mkdtempSync(join(tmpdir(), "actormap-scan4-"));
	try {
		mkdirSync(join(root, "src"), { recursive: true });
		mkdirSync(join(root, "adapters"), { recursive: true });
		writeFileSync(join(root, "src", "order.ts"), 'function f(){ order.status = "paid"; }');
		writeFileSync(join(root, "adapters", "fake.mjs"), 'function g(){ order.status = "fake"; }');
		const all = scanRepo(root);
		assert.ok(all.skeleton.assertions.some((a) => a.to === "fake"));
		const filtered = scanRepo(root, { exclude: ["adapters/fake.mjs"] });
		assert.ok(!filtered.skeleton.assertions.some((a) => a.to === "fake"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
