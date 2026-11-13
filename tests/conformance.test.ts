import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IRFile } from "../src/ir/types.ts";
import { emptyIR } from "../src/ir/types.ts";
import { addActor, addAssertion } from "../src/ir/store.ts";
import { deriveCases, pathTo } from "../src/conformance/cases.ts";
import { runConformanceWithAdapter } from "../src/conformance/harness.ts";
import { summarize } from "../src/conformance/report.ts";
import type { ConformanceAdapter } from "../src/conformance/harness.ts";

function demoIR(): IRFile {
	const ir = emptyIR("报销");
	addActor(ir, { id: "employee", name: "员工", type: "human" });
	addActor(ir, { id: "manager", name: "主管", type: "human" });
	addAssertion(ir, { from: "∅", action: "create", to: "draft", by: "employee", source: "新建" });
	addAssertion(ir, { from: "draft", action: "submit", to: "submitted", by: "employee", guards: ["金额 > 0"], source: "提交" });
	addAssertion(ir, {
		from: "submitted",
		action: "approve",
		to: "approved",
		by: "manager",
		guards: ["金额 <= 5000"],
		verify: "已通过",
		source: "批",
	});
	return ir;
}

/** 正确实现：按 IR 干活 */
function goodAdapter(): ConformanceAdapter {
	const rows = new Map<string, { status: string; amount: number }>();
	let seq = 0;
	const owner: Record<string, string> = { submit: "employee", approve: "manager" };
	return {
		name: "good",
		create(actor, ctx) {
			if (actor !== "employee") throw new Error("只有员工能建");
			const id = `o${++seq}`;
			rows.set(id, { status: "draft", amount: Number(ctx.金额 ?? 0) });
			return id;
		},
		act(id, action, ctx, actor) {
			const row = rows.get(id);
			if (!row) throw new Error("not found");
			if (owner[action] !== actor) throw new Error(`角色 ${actor} 不能 ${action}`);
			const amount = Number(ctx.金额 ?? row.amount);
			if (action === "submit") {
				if (!(amount > 0)) throw new Error("金额必须大于 0");
				row.status = "submitted";
			} else if (action === "approve") {
				if (!(amount <= 5000)) throw new Error("超过 5000 要财务复核");
				row.status = "approved";
			}
		},
		state(id) {
			const row = rows.get(id);
			if (!row) throw new Error("not found");
			return row.status;
		},
	};
}

/** 阈值写错的实现 */
function offByAdapter(): ConformanceAdapter {
	const base = goodAdapter();
	const rows = new Map<string, { status: string; amount: number }>();
	let seq = 0;
	return {
		...base,
		name: "off-by-1000",
		create(actor, ctx) {
			const id = `x${++seq}`;
			rows.set(id, { status: "draft", amount: Number(ctx.金额 ?? 0) });
			return id;
		},
		act(id, action, ctx) {
			const row = rows.get(id)!;
			const amount = Number(ctx.金额 ?? row.amount);
			if (action === "submit") row.status = "submitted";
			// bug：阈值写成 6000
			else if (action === "approve" && amount <= 6000) row.status = "approved";
		},
		state(id) {
			return rows.get(id)!.status;
		},
	};
}

test("用例覆盖正例、条件反例、角色反例", () => {
	const { cases } = deriveCases(demoIR());
	const kinds = new Set(cases.map((c) => c.kind));
	assert.ok(kinds.has("positive"));
	assert.ok(kinds.has("guard-negative"));
	assert.ok(kinds.has("actor-negative"));
	// 边界值：<=5000 的正例取 5000，反例取 5001
	const approve = cases.filter((c) => c.assertionId === "a_003");
	assert.equal(approve.find((c) => c.kind === "positive")?.ctx["金额"], 5000);
	assert.equal(approve.find((c) => c.kind === "guard-negative")?.ctx["金额"], 5001);
});

test("解析不了的条件整条跳过，并说明原因", () => {
	const ir = demoIR();
	addAssertion(ir, { from: "submitted", action: "reject", to: "draft", by: "manager", guards: ["发票不合规"], source: "驳" });
	const { skipped } = deriveCases(ir);
	assert.ok(skipped.some((s) => s.assertionId === "a_004"));
	assert.match(skipped[0].reason, /解析不了/);
});

test("守规矩的实现在契约测试里全绿", async () => {
	const report = await runConformanceWithAdapter(demoIR(), goodAdapter());
	const summary = summarize(report);
	assert.equal(summary.total, 8, JSON.stringify(report.results.map((r) => r.case.id)));
	assert.equal(summary.failed, 0, JSON.stringify(report.results.filter((r) => r.outcome === "fail"), null, 2));
	assert.ok(summary.ok);
});

test("阈值写错会被反例抓到", async () => {
	const report = await runConformanceWithAdapter(demoIR(), offByAdapter());
	const failed = report.results.filter((r) => r.outcome === "fail");
	assert.ok(failed.length > 0);
	assert.ok(failed.some((r) => r.case.kind === "guard-negative" && r.case.assertionId === "a_003"));
	assert.match(failed[0].detail ?? "", /放行/);
});

test("被拒绝后状态被改脏也会被抓", async () => {
	const rows = new Map<string, { status: string; amount: number }>();
	let seq = 0;
	const dirty: ConformanceAdapter = {
		name: "dirty",
		create(actor, ctx) {
			const id = `d${++seq}`;
			rows.set(id, { status: "draft", amount: Number(ctx.金额 ?? 0) });
			return id;
		},
		act(id, action, ctx) {
			const row = rows.get(id)!;
			if (action === "submit") row.status = "submitted";
			if (action === "approve") {
				row.status = "approved"; // 先写库再校验 —— 典型实现 bug
				throw new Error("金额超限");
			}
		},
		state(id) {
			return rows.get(id)!.status;
		},
	};
	const report = await runConformanceWithAdapter(demoIR(), dirty);
	const failed = report.results.filter((r) => r.outcome === "fail");
	assert.ok(failed.some((r) => (r.detail ?? "").includes("不应变化")));
});

test("从代码连不上前置状态时给 skip，不硬判", async () => {
	const ir = demoIR();
	addActor(ir, { id: "sweeper", name: "系统", type: "system", trigger: "30 天" });
	addAssertion(ir, { from: "closed", action: "reopen", to: "draft", by: "sweeper", source: "重开" });
	const report = await runConformanceWithAdapter(ir, goodAdapter());
	const skip = report.results.find((r) => r.case.assertionId === "a_004" && r.outcome === "skip");
	assert.ok(skip, "closed 没有任何入边，应该 skip 而不是判失败");
});

test("pathTo 能找到创建到目标状态的动作序列", () => {
	const steps = pathTo(demoIR(), "main", "submitted");
	assert.ok(steps);
	assert.deepEqual(steps.map((s) => s.action), ["create", "submit"]);
});
