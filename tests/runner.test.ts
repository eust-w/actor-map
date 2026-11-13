import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyIR } from "../src/ir/types.ts";
import { addActor, addAssertion } from "../src/ir/store.ts";
import { exportRunner } from "../src/export/runner.ts";

async function build() {
	const ir = emptyIR("报销");
	addActor(ir, { id: "employee", name: "员工", type: "human" });
	addActor(ir, { id: "manager", name: "主管", type: "human" });
	addActor(ir, { id: "sweeper", name: "超时任务", type: "system", trigger: "30 天" });
	addAssertion(ir, { from: "∅", action: "create", to: "draft", by: "employee", source: "新建" });
	addAssertion(ir, { from: "draft", action: "submit", to: "submitted", by: "employee", guards: ["金额 > 0"], source: "提交" });
	addAssertion(ir, { from: "submitted", action: "approve", to: "approved", by: "manager", guards: ["金额 <= 5000"], verify: "已通过", source: "批" });
	addAssertion(ir, { from: "submitted", action: "escalate", to: "pending_finance", by: "manager", guards: ["金额 > 5000"], source: "转财务" });
	addAssertion(ir, { from: "submitted", action: "auto_close", to: "closed", by: "sweeper", guards: ["now - submitted_at > 30d"], source: "超时" });

	const dir = mkdtempSync(join(tmpdir(), "actormap-runner-"));
	const file = join(dir, "runner.mjs");
	writeFileSync(file, exportRunner(ir), "utf8");
	const mod = await import(file);
	return { mod, dir };
}

test("导出的参考状态机可以直接跑", async () => {
	const { mod, dir } = await build();
	try {
		assert.equal(mod.apply("draft", "submit", { 金额: 100 }, "employee").allowed, true);
		assert.equal(mod.apply("draft", "submit", { 金额: 0 }, "employee").allowed, false);
		assert.equal(mod.apply("submitted", "approve", { 金额: 4000 }, "manager").to, "approved");
		assert.equal(mod.apply("submitted", "approve", { 金额: 9000 }, "manager").reason, "guard-rejected");
		assert.equal(mod.apply("submitted", "escalate", { 金额: 9000 }, "manager").to, "pending_finance");
		assert.equal(mod.create("main", "employee"), "draft");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("解析不了的条件不猜，标成 unchecked", async () => {
	const { mod, dir } = await build();
	try {
		const result = mod.apply("submitted", "auto_close", {}, "sweeper");
		assert.equal(result.allowed, true);
		assert.ok(result.checks.some((c: string) => c.includes("now - submitted_at")));
		assert.ok(mod.unchecked.some((u: string) => u.includes("a_005")));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("角色不对时不允许", async () => {
	const { mod, dir } = await build();
	try {
		assert.equal(mod.apply("submitted", "approve", { 金额: 100 }, "employee").allowed, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
