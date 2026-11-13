import { test } from "node:test";
import assert from "node:assert/strict";
import type { Assertion, IRFile } from "../src/ir/types.ts";
import { parseGuard, toInterval } from "../src/validate/guards.ts";
import { validate } from "../src/validate/validate.ts";

function ir(...assertions: Array<Partial<Assertion>>): IRFile {
	return {
		product: "t",
		version: 1,
		updatedAt: "",
		actors: [
			{ id: "employee", name: "员工", type: "human" },
			{ id: "manager", name: "主管", type: "human" },
			{ id: "sweeper", name: "超时任务", type: "system", trigger: "30 天" },
		],
		assertions: assertions.map((a, i) => ({
			id: `a_${String(i + 1).padStart(3, "0")}`,
			entity: "order",
			from: "submitted",
			action: "act",
			to: "done",
			by: "manager",
			guards: [],
			verify: "",
			source: "原话",
			status: "confirmed",
			...a,
		})) as Assertion[],
		terminals: ["done"],
	};
}

const codes = (target: IRFile) => validate(target).issues.map((i) => i.code);

test("解析金额比较", () => {
	const parsed = parseGuard("金额 > 5000 && 已上传发票");
	assert.equal(parsed.numeric.length, 1);
	assert.equal(parsed.numeric[0].variable, "金额");
	assert.equal(parsed.numeric[0].op, ">");
	assert.deepEqual(parsed.unparsed, ["已上传发票"]);
});

test("时间表达式进 unparsed，不被当成无条件", () => {
	const parsed = parseGuard("now - submitted_at > 30d");
	assert.equal(parsed.numeric.length, 0);
	assert.equal(parsed.unparsed.length, 1);
});

test("区间求交", () => {
	const interval = toInterval([
		{ variable: "金额", op: ">=", value: 10 },
		{ variable: "金额", op: "<", value: 20 },
	]);
	assert.equal(interval.lo, 10);
	assert.equal(interval.loInc, true);
	assert.equal(interval.hi, 20);
	assert.equal(interval.hiInc, false);
});

test("分支之间留了空档 → 追问这段归谁管", () => {
	const target = ir(
		{ action: "approve", to: "approved", guards: ["金额 <= 3000"] },
		{ action: "escalate", to: "pending_finance", guards: ["金额 > 5000"] },
	);
	const gap = validate(target).issues.find((i) => i.code === "branch_gap");
	assert.ok(gap, "3000~5000 之间无人覆盖，应当报出来");
	assert.match(gap.question, /3000/);
	assert.match(gap.question, /5000/);
});

test("分支区间重叠 → 行为不确定", () => {
	const target = ir(
		{ action: "approve", to: "approved", guards: ["金额 <= 5000"] },
		{ action: "escalate", to: "pending_finance", guards: ["金额 >= 5000"] },
	);
	const overlap = validate(target).issues.find((i) => i.code === "branch_overlap");
	assert.ok(overlap);
	assert.equal(overlap.severity, "error");
});

test("完整覆盖不报空档", () => {
	const target = ir(
		{ action: "approve", to: "approved", guards: ["金额 <= 5000"] },
		{ action: "escalate", to: "pending_finance", guards: ["金额 > 5000"] },
	);
	assert.ok(!codes(target).includes("branch_gap"));
	assert.ok(!codes(target).includes("branch_overlap"));
});

test("单条分支条件自相矛盾", () => {
	const target = ir(
		{ action: "approve", to: "approved", guards: ["金额 > 5000", "金额 < 1000"] },
		{ action: "escalate", to: "pending_finance", guards: ["金额 >= 1000"] },
	);
	assert.ok(codes(target).includes("unsatisfiable_guard"));
});

test("有无法解析的条件时，不臆断重叠或空档", () => {
	const target = ir(
		{ action: "approve", to: "approved", guards: ["金额 <= 5000"] },
		{ action: "auto_close", to: "closed", by: "sweeper", guards: ["now - submitted_at > 30d"] },
	);
	const found = codes(target);
	assert.ok(!found.includes("branch_overlap"));
	assert.ok(!found.includes("branch_gap"));
});

test("同一状态同一动作两个发起者 → 问谁说了算", () => {
	const target = ir(
		{ action: "approve", to: "approved", by: "manager" },
		{ action: "approve", to: "approved", by: "sweeper" },
	);
	assert.ok(codes(target).includes("ambiguous_owner"));
});
