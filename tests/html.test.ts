import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyIR } from "../src/ir/types.ts";
import { addActor, addAssertion } from "../src/ir/store.ts";
import { validate } from "../src/validate/validate.ts";
import { renderHTML } from "../src/report/html.ts";

function demo() {
	const ir = emptyIR("报销 <测试>");
	addActor(ir, { id: "u", name: "员工", type: "human" });
	addActor(ir, { id: "m", name: "主管", type: "human" });
	addAssertion(ir, { from: "∅", action: "create", to: "draft", by: "u", source: "新建" });
	addAssertion(ir, { from: "draft", action: "submit", to: "submitted", by: "u", source: "提交" });
	addAssertion(ir, { from: "submitted", action: "approve", to: "approved", by: "m", source: "批" });
	addAssertion(ir, { from: "submitted", action: "reject", to: "draft", by: "m", source: "驳" });
	return ir;
}

test("地图是自包含的，不引用外部资源", () => {
	const html = renderHTML(demo(), validate(demo()));
	assert.match(html, /<svg/);
	assert.doesNotMatch(html, /<script[^>]+src=/);
	assert.doesNotMatch(html, /<link[^>]+href=/);
	assert.match(html, /<style>/);
});

test("状态和动作都在图上，且带交互需要的数据属性", () => {
	const ir = demo();
	const html = renderHTML(ir, validate(ir));
	for (const state of ["draft", "submitted", "approved"]) assert.ok(html.includes(state), state);
	assert.match(html, /data-state="draft"/);
	assert.match(html, /data-f="draft"/);
	assert.match(html, /edge-label/);
});

test("用户输入不会被当成 HTML 执行", () => {
	const ir = demo();
	const html = renderHTML(ir, validate(ir));
	assert.ok(html.includes("报销 &lt;测试&gt;"));
	assert.ok(!html.includes("报销 <测试>"));
});

test("缺口带着追问一起进地图", () => {
	const ir = demo();
	const result = validate(ir);
	const html = renderHTML(ir, result);
	const withQuestion = result.issues.find((i) => i.question.length > 0);
	assert.ok(withQuestion);
	assert.ok(html.includes("问："));
});

test("空 IR 也能渲染", () => {
	const ir = emptyIR("空");
	const html = renderHTML(ir, validate(ir));
	assert.match(html, /还没有任何断言/);
});
