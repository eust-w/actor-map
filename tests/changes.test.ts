import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyIR } from "../src/ir/types.ts";
import { addActor, addAssertion } from "../src/ir/store.ts";
import { applyChangeSet } from "../src/ir/changes.ts";
import { validate } from "../src/validate/validate.ts";

function base() {
	const ir = emptyIR("报销");
	addActor(ir, { id: "employee", name: "员工", type: "human" });
	addActor(ir, { id: "manager", name: "主管", type: "human" });
	addAssertion(ir, { from: "∅", action: "create", to: "draft", by: "employee", source: "员工新建" });
	addAssertion(ir, { from: "draft", action: "submit", to: "submitted", by: "employee", source: "提交" });
	addAssertion(ir, {
		from: "submitted",
		action: "approve",
		to: "approved",
		by: "manager",
		guards: ["金额 <= 3000"],
		source: "主管批",
	});
	return ir;
}

test("改需求走变更集，不是覆盖写", () => {
	const ir = base();
	const result = applyChangeSet(ir, "允许主管驳回", [
		{
			op: "add",
			assertion: { entity: "main", from: "submitted", action: "reject", to: "draft", by: "manager", guards: ["金额 > 5000"], verify: "", source: "主管可以驳", status: "confirmed" },
		},
	]);
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(ir.changesets?.length, 1);
	assert.equal(ir.changesets?.[0].reason, "允许主管驳回");
	assert.equal(ir.version, 1);
	assert.equal(result.impact.added.length, 1);
});

test("变更必须写理由", () => {
	const ir = base();
	const result = applyChangeSet(ir, "  ", [{ op: "remove", id: "a_003" }]);
	assert.equal(result.ok, false);
	assert.match(result.ok ? "" : result.error, /reason/);
});

test("影响分析：改动会引出新的缺口", () => {
	const ir = base();
	const result = applyChangeSet(ir, "主管驳回只覆盖大额", [
		{
			op: "add",
			assertion: { entity: "main", from: "submitted", action: "reject", to: "draft", by: "manager", guards: ["金额 > 5000"], verify: "", source: "只驳大额", status: "confirmed" },
		},
	]);
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.ok(result.impact.fixed.length + result.impact.introduced.length > 0);
});

test("删除留墓碑，不静默消失", () => {
	const ir = base();
	const result = applyChangeSet(ir, "主管不再驳回", [{ op: "remove", id: "a_003" }]);
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(ir.assertions.length, 2);
	assert.equal(ir.tombstones?.length, 1);
	assert.equal(ir.tombstones?.[0].assertion.id, "a_003");
	assert.match(ir.tombstones?.[0].reason ?? "", /不再驳回/);
	assert.ok(ir.tombstones?.[0].changeSet.startsWith("cs_"));
});

test("改动冲突时拒绝，而不是悄悄覆盖", () => {
	const ir = base();
	const result = applyChangeSet(ir, "把 approve 改成 reject", [
		{ op: "modify", id: "a_003", patch: { action: "reject" } },
	]);
	// 没有冲突，应当成功
	assert.equal(result.ok, true);

	const ir2 = base();
	const first = applyChangeSet(ir2, "加一条 reject", [
		{ op: "add", assertion: { entity: "main", from: "submitted", action: "reject", to: "draft", by: "manager", guards: [], verify: "", source: "驳", status: "confirmed" } },
	]);
	assert.equal(first.ok, true);
	const clash = applyChangeSet(ir2, "再把 approve 也改成 reject", [{ op: "modify", id: "a_003", patch: { action: "reject" } }]);
	assert.equal(clash.ok, false);
	assert.match(clash.ok ? "" : clash.error, /冲突/);
});

test("改一条断言后，下游兄弟分支被列入复核清单", () => {
	const ir = base();
	addAssertion(ir, { from: "submitted", action: "escalate", to: "pending_finance", by: "manager", guards: ["金额 > 3000"], source: "大额转财务" });
	const result = applyChangeSet(ir, "把阈值从 3000 改到 2000", [
		{ op: "modify", id: "a_003", patch: { guards: ["金额 <= 2000"] } },
	]);
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.ok(result.impact.tasks.some((t) => t.includes("复核")));
});

test("确认终态也是一种变更", () => {
	const ir = base();
	assert.ok(validate(ir).issues.some((i) => i.code === "unconfirmed_terminal"));
	const result = applyChangeSet(ir, "确认 approved 是终态", [{ op: "ack_terminal", state: "main:approved" }]);
	assert.equal(result.ok, true);
	assert.ok(!validate(ir).issues.some((i) => i.code === "unconfirmed_terminal"));
});

test("找不到的断言 id 直接报错", () => {
	const ir = base();
	const result = applyChangeSet(ir, "删掉不存在的", [{ op: "remove", id: "a_999" }]);
	assert.equal(result.ok, false);
	assert.match(result.ok ? "" : result.error, /找不到/);
});
