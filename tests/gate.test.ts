import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IRFile } from "../src/ir/types.ts";
import { emptyIR } from "../src/ir/types.ts";
import { addActor, addAssertion } from "../src/ir/store.ts";
import { gateMarkdown, runGate } from "../src/gate/index.ts";

function demoIR(): IRFile {
	const ir = emptyIR("报销");
	addActor(ir, { id: "employee", name: "员工", type: "human" });
	addActor(ir, { id: "manager", name: "主管", type: "human" });
	addAssertion(ir, { from: "∅", action: "create", to: "draft", by: "employee", source: "新建" });
	addAssertion(ir, { from: "draft", action: "submit", to: "submitted", by: "employee", guards: ["金额 > 0"], source: "提交" });
	addAssertion(ir, { from: "submitted", action: "approve", to: "approved", by: "manager", guards: ["金额 <= 5000"], source: "批" });
	return ir;
}

const CODE_OK = `
router.post("/orders/:id/submit", async (req, res) => {
  if (order.status === "draft") { order.status = "submitted"; }
});
router.post("/orders/:id/approve", async (req, res) => {
  if (order.status === "submitted") { order.status = "approved"; }
});
`;

const CODE_DRIFTED = `${CODE_OK}
router.post("/orders/:id/cancel", async (req, res) => {
  if (order.status === "submitted") { order.status = "cancelled"; }
});
`;

const ADAPTER = `
const rows = new Map();
let seq = 0;
const owner = { submit: "employee", approve: "manager" };
export default {
  name: "test-adapter",
  create(actor, ctx) {
    if (actor !== "employee") throw new Error("只有员工能建");
    const id = "o" + ++seq;
    rows.set(id, { status: "draft", amount: Number(ctx["金额"] ?? 0) });
    return id;
  },
  act(id, action, ctx, actor) {
    const row = rows.get(id);
    if (!row) throw new Error("not found");
    if (owner[action] !== actor) throw new Error("角色不对");
    const amount = Number(ctx["金额"] ?? row.amount);
    if (action === "submit") {
      if (!(amount > 0)) throw new Error("金额必须大于 0");
      row.status = "submitted";
    } else if (action === "approve") {
      if (!(amount <= 5000)) throw new Error("超过 5000 要复核");
      row.status = "approved";
    }
  },
  state(id) { return rows.get(id).status; },
};
`;

function workspace(code: string): string {
	const dir = mkdtempSync(join(tmpdir(), "actormap-gate-"));
	mkdirSync(join(dir, "product"), { recursive: true });
	writeFileSync(join(dir, "product", "order.controller.ts"), code, "utf8");
	writeFileSync(join(dir, "adapter.mjs"), ADAPTER, "utf8");
	return dir;
}

test("三项检查全过时门禁通过", async () => {
	const dir = workspace(CODE_OK);
	try {
		const report = await runGate(demoIR(), { cwd: dir, repo: "product", adapter: "adapter.mjs" });
		assert.equal(report.ok, true, JSON.stringify(report.checks, null, 2));
		assert.equal(report.checks.length, 3);
		assert.deepEqual(report.checks.map((c) => c.status), ["pass", "pass", "pass"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("代码偷偷加了一条迁移，门禁拦下", async () => {
	const dir = workspace(CODE_DRIFTED);
	try {
		const report = await runGate(demoIR(), { cwd: dir, repo: "product", adapter: "adapter.mjs" });
		assert.equal(report.ok, false);
		const drift = report.checks.find((c) => c.id === "drift");
		assert.equal(drift?.status, "fail");
		assert.match(drift?.details.join("\n") ?? "", /cancel/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("豁免清单能放行已知漂移，并记下理由", async () => {
	const dir = workspace(CODE_DRIFTED);
	try {
		const report = await runGate(demoIR(), {
			cwd: dir,
			repo: "product",
			adapter: "adapter.mjs",
			waivers: {
				allowDrift: [{ from: "submitted", action: "cancel", to: "cancelled", reason: "PR #42，下个迭代补 IR" }],
			},
		});
		const drift = report.checks.find((c) => c.id === "drift");
		assert.equal(drift?.status, "pass");
		assert.deepEqual(drift?.waived, ["submitted|cancel|cancelled"]);
		assert.match(drift?.summary ?? "", /已豁免 1/);
		assert.equal(report.ok, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("warnOnly 把拦下的项降级成警告", async () => {
	const dir = workspace(CODE_DRIFTED);
	try {
		const report = await runGate(demoIR(), {
			cwd: dir,
			repo: "product",
			adapter: "adapter.mjs",
			waivers: { warnOnly: ["drift"] },
		});
		const drift = report.checks.find((c) => c.id === "drift");
		assert.equal(drift?.status, "warn");
		assert.equal(report.ok, true, "降级后不应拦下");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("实现违反契约时门禁拦下", async () => {
	const dir = workspace(CODE_OK);
	try {
		writeFileSync(
			join(dir, "adapter.mjs"),
			ADAPTER.replace("amount <= 5000", "amount <= 6000"),
			"utf8",
		);
		const report = await runGate(demoIR(), { cwd: dir, repo: "product", adapter: "adapter.mjs" });
		assert.equal(report.ok, false);
		const conformance = report.checks.find((c) => c.id === "conformance");
		assert.equal(conformance?.status, "fail");
		assert.match(conformance?.summary ?? "", /失败/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("没有仓库和适配器时是 skip，不是假装通过", async () => {
	const dir = workspace(CODE_OK);
	try {
		const report = await runGate(demoIR(), { cwd: dir });
		assert.deepEqual(report.checks.map((c) => c.status), ["pass", "skip", "skip"]);
		assert.equal(report.checks.filter((c) => c.status === "skip").length, 2);
		assert.equal(report.ok, true, "skip 不拦人");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("仓库路径写错会直接失败，而不是静默通过", async () => {
	const dir = workspace(CODE_OK);
	try {
		const report = await runGate(demoIR(), { cwd: dir, repo: "nope" });
		const drift = report.checks.find((c) => c.id === "drift");
		assert.equal(drift?.status, "fail");
		assert.equal(report.ok, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("IR 本身不自洽时 validate 拦下", async () => {
	const dir = workspace(CODE_OK);
	try {
		const ir = demoIR();
		addAssertion(ir, { from: "submitted", action: "approve", to: "archived", by: "manager", source: "重复定义" }).ok;
		// 直接造一个未登记的 actor，绕过工具边界
		ir.assertions.push({
			id: "a_099",
			entity: "main",
			from: "draft",
			action: "hack",
			to: "submitted",
			by: "ghost",
			guards: [],
			verify: "",
			source: "",
			status: "assumed",
		});
		const report = await runGate(ir, { cwd: dir, repo: "product", adapter: "adapter.mjs" });
		const validateCheck = report.checks.find((c) => c.id === "validate");
		assert.equal(validateCheck?.status, "fail");
		assert.match(validateCheck?.details.join("\n") ?? "", /unknown_actor/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("Markdown 摘要能贴到 PR 里", async () => {
	const dir = workspace(CODE_DRIFTED);
	try {
		const report = await runGate(demoIR(), { cwd: dir, repo: "product" });
		const md = gateMarkdown(report);
		assert.match(md, /门禁未通过/);
		assert.match(md, /\| 检查 \| 结果 \| 说明 \|/);
		assert.match(md, /<details>/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
