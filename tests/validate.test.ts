import { test } from "node:test";
import assert from "node:assert/strict";
import type { Assertion, IRFile } from "../src/ir/types.ts";
import { addActor, addAssertion, acknowledgeTerminals } from "../src/ir/store.ts";
import { emptyIR } from "../src/ir/types.ts";
import { validate } from "../src/validate/validate.ts";

function ir(...assertions: Array<Partial<Assertion>>): IRFile {
	const base: IRFile = {
		product: "测试产品",
		version: 1,
		updatedAt: "",
		actors: [
			{ id: "employee", name: "员工", type: "human" },
			{ id: "manager", name: "主管", type: "human" },
			{ id: "sweeper", name: "超时关单任务", type: "system", trigger: "submitted 超过 30 天" },
		],
		assertions: assertions.map((a, i) => ({
			id: `a_${String(i + 1).padStart(3, "0")}`,
			entity: "order",
			from: "draft",
			action: "act",
			to: "done",
			by: "employee",
			guards: [],
			verify: "",
			source: "员工说的",
			status: "confirmed",
			...a,
		})),
		terminals: [],
	};
	return base;
}

const codes = (target: IRFile) => validate(target).issues.map((i) => i.code);

test("自洽的流程不报错误", () => {
	const target = ir(
		{ from: "∅", action: "create", to: "draft", source: "员工新建报销单" },
		{ from: "draft", action: "submit", to: "submitted" },
		{ from: "submitted", action: "approve", to: "approved", by: "manager", source: "主管说批" },
		{ from: "submitted", action: "reject", to: "draft", by: "manager", guards: ["金额超标"], source: "主管说驳" },
	);
	acknowledgeTerminals(target, ["order:approved"]);
	const result = validate(target);
	assert.equal(result.stats.errors, 0, JSON.stringify(result.issues, null, 2));
	assert.equal(result.stats.assertions, 4);
});

test("没记录创建动作时，入口降级为推断并追问", () => {
	const target = ir(
		{ from: "draft", action: "submit", to: "submitted" },
		{ from: "submitted", action: "approve", to: "approved", by: "manager" },
	);
	const issue = validate(target).issues.find((i) => i.code === "implicit_entry");
	assert.ok(issue);
	assert.match(issue.question, /创建/);
});

test("走到不了的孤岛状态会被抓出来", () => {
	const target = ir(
		{ from: "∅", action: "create", to: "draft" },
		{ from: "draft", action: "submit", to: "submitted" },
		{ from: "isolated", action: "something", to: "nowhere" },
	);
	assert.ok(codes(target).includes("unreachable_state"));
});

test("没有出口的闭环被判死锁", () => {
	const target = ir(
		{ from: "draft", action: "submit", to: "submitted" },
		{ from: "submitted", action: "reject", to: "fixing" },
		{ from: "fixing", action: "resubmit", to: "submitted" },
	);
	const found = codes(target);
	assert.ok(found.includes("loop_without_exit"));
	assert.ok(found.includes("no_terminal_path"));
});

test("同一状态同一动作两种结果 = 行为不确定", () => {
	const target = ir(
		{ from: "draft", action: "submit", to: "submitted" },
		{ from: "draft", action: "submit", to: "archived", by: "manager" },
	);
	assert.ok(codes(target).includes("ambiguous_transition"));
});

test("没有任何动作的角色会被点名", () => {
	const target = ir({ from: "draft", action: "submit", to: "submitted" });
	assert.ok(codes(target).includes("orphan_actor"));
});

test("多分支但无条件 → 追问判断依据", () => {
	const target = ir(
		{ from: "draft", action: "submit", to: "submitted" },
		{ from: "submitted", action: "approve", to: "approved", by: "manager" },
		{ from: "submitted", action: "reject", to: "draft", by: "manager" },
	);
	const issue = validate(target).issues.find((i) => i.code === "unguarded_branch");
	assert.ok(issue);
	assert.match(issue.question, /走/);
});

test("没有原话依据的断言降级为待确认", () => {
	const target = emptyIR("t");
	addActor(target, { id: "u", name: "用户", type: "human" });
	const outcome = addAssertion(target, { from: "∅", action: "create", to: "draft", by: "u" });
	assert.equal(outcome.ok, true);
	assert.equal(target.assertions[0].status, "assumed");
	assert.ok(codes(target).includes("missing_source"));
});

test("未确认的终态持续追问，确认后消失", () => {
	const target = ir(
		{ from: "draft", action: "submit", to: "submitted" },
		{ from: "submitted", action: "approve", to: "approved", by: "manager" },
	);
	assert.ok(codes(target).includes("unconfirmed_terminal"));
	acknowledgeTerminals(target, ["order:approved"]);
	assert.ok(!codes(target).includes("unconfirmed_terminal"));
});

test("写断言时 actor 未登记被工具边界挡住", () => {
	const target = ir();
	const outcome = addAssertion(target, { from: "draft", action: "submit", to: "submitted", by: "ghost" });
	assert.equal(outcome.ok, false);
	assert.match(outcome.ok === false ? outcome.error : "", /未登记/);
});

test("同 id 的 actor 重复登记是更新而不是新增", () => {
	const target = ir();
	addActor(target, { id: "employee", name: "员工", type: "human" });
	assert.equal(target.actors.filter((a) => a.id === "employee").length, 1);
});
