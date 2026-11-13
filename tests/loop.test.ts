/**
 * 闭环测试：模拟一场 5 轮访谈，只走三个工具背后的函数，不经过模型。
 *
 * 它回答一个问题：如果模型问得对，这份 IR 能不能在 5 轮内收敛到 0 错误？
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyIR } from "../src/ir/types.ts";
import { acknowledgeTerminals, addActor, addAssertion } from "../src/ir/store.ts";
import { validate } from "../src/validate/validate.ts";

test("5 轮访谈把一张报销流程聊到 0 错误", () => {
	const ir = emptyIR("报销系统");
	const step = (input: Parameters<typeof addAssertion>[1]) => {
		const outcome = addAssertion(ir, input);
		assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.error);
	};

	// 第 1 轮：角色（含非人）
	addActor(ir, { id: "employee", name: "员工", type: "human" });
	addActor(ir, { id: "manager", name: "直属主管", type: "human" });
	addActor(ir, { id: "finance", name: "财务", type: "human" });
	addActor(ir, {
		id: "sweeper",
		name: "超时关单任务",
		type: "system",
		trigger: "submitted 超过 30 天",
	});

	// 第 1 轮结束仍是一片空白，校验器只会说"还没有断言"
	assert.ok(validate(ir).issues.some((i) => i.code === "empty_ir"));

	// 第 2 轮：创建 —— 入口第一次被显式说出来
	step({ from: "∅", action: "create", to: "draft", by: "employee", source: "员工点新建" });

	// 第 3 轮：主路径
	step({
		from: "draft",
		action: "submit",
		to: "submitted",
		by: "employee",
		guards: ["金额>0"],
		source: "填完点提交",
	});

	// 第 4 轮：分支
	step({ from: "submitted", action: "approve", to: "approved", by: "manager", guards: ["金额<=5000"], source: "主管点通过" });
	step({ from: "submitted", action: "reject", to: "draft", by: "manager", guards: ["发票不合规"], source: "主管可以驳回" });
	step({ from: "approved", action: "pay", to: "paid", by: "finance", source: "财务打款" });

	// 第 5 轮：非人角色
	step({ from: "submitted", action: "auto_close", to: "closed", by: "sweeper", guards: ["now-submitted_at>30d"], source: "超过三十天自动关单" });

	const before = validate(ir);
	// 此时只剩"这些终态确认了吗"，没有结构性错误
	assert.equal(before.stats.errors, 0, JSON.stringify(before.issues, null, 2));
	const pending = before.issues.filter((i) => i.code === "unconfirmed_terminal").map((i) => i.refs[0]);
	assert.deepEqual(pending.sort(), ["closed", "paid"]);

	// 收尾：确认终态
	acknowledgeTerminals(ir, pending);
	const after = validate(ir);

	assert.equal(after.stats.errors, 0);
	assert.equal(after.stats.warnings, 0, JSON.stringify(after.issues, null, 2));
	assert.equal(after.stats.assertions, 6);
	assert.equal(after.stats.confirmed, 6);
	assert.equal(after.graphs[0].initial[0], "draft");
	assert.deepEqual(after.graphs[0].terminal.sort(), ["closed", "paid"]);
});

test("中途漏掉异常路径时，校验器会把问题推回给访谈", () => {
	const ir = emptyIR("请假");
	addActor(ir, { id: "employee", name: "员工", type: "human" });
	addActor(ir, { id: "manager", name: "主管", type: "human" });

	addAssertion(ir, { from: "∅", action: "create", to: "draft", by: "employee", source: "员工发起" });
	addAssertion(ir, { from: "draft", action: "submit", to: "submitted", by: "employee", source: "提交" });
	addAssertion(ir, { from: "submitted", action: "approve", to: "approved", by: "manager", source: "主管批" });

	const result = validate(ir);
	const branch = result.issues.find((i) => i.code === "unconfirmed_terminal");
	assert.ok(branch, "approved 作为未确认终态应当被追问");
	assert.match(branch.question, /终点/);
});
