import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IRFile } from "../src/ir/types.ts";
import { emptyIR } from "../src/ir/types.ts";
import { addActor, addAssertion } from "../src/ir/store.ts";
import { buildIrFix, mergeFixes } from "../src/gate/suggest.ts";
import { runGate } from "../src/gate/index.ts";
import { applyChangeSet } from "../src/ir/changes.ts";
import { validate } from "../src/validate/validate.ts";

function demoIR(): IRFile {
	const ir = emptyIR("报销");
	addActor(ir, { id: "employee", name: "员工", type: "human" });
	addActor(ir, { id: "manager", name: "主管", type: "human" });
	addAssertion(ir, { entity: "order", from: "∅", action: "create", to: "draft", by: "employee", source: "新建" });
	addAssertion(ir, { entity: "order", from: "draft", action: "submit", to: "submitted", by: "employee", source: "提交" });
	return ir;
}

const CODE = `
router.post("/orders/:id/submit", async (req, res) => {
  if (order.status === "draft" && req.user.role === "employee") {
    order.status = "submitted";
  }
});
`;

const CODE_WITH_CANCEL = `${CODE}
router.post("/orders/:id/cancel", async (req, res) => {
  if (order.status === "submitted" && req.user.role === "employee") {
    order.status = "cancelled";
  }
});
`;

function workspace(code: string): string {
	const dir = mkdtempSync(join(tmpdir(), "actormap-fix-"));
	mkdirSync(join(dir, "service"), { recursive: true });
	writeFileSync(join(dir, "service", "order.controller.ts"), code, "utf8");
	return dir;
}

test("反向建议带出可粘贴的 YAML 和可执行的命令", () => {
	const ir = demoIR();
	const fix = buildIrFix(ir, {
		id: "a_900",
		entity: "Order",
		from: "submitted",
		action: "cancel",
		to: "cancelled",
		by: "manager",
		guards: [],
		verify: "",
		source: "代码：order.controller.ts:59",
		status: "confirmed",
		evidence: { file: "order.controller.ts", line: 59, actorHint: "employee" },
	});
	assert.ok(fix);
	assert.equal(fix.entity, "order", "Order 应当对上已有的 order");
	assert.equal(fix.by, "employee", "用代码里的角色线索，而不是默认 actor");
	assert.equal(fix.status, "confirmed");
	assert.match(fix.yaml, /^- entity: order/m);
	assert.match(fix.yaml, /action: cancel/);
	assert.match(fix.command, /actormap change --file/);
	assert.equal(JSON.parse(fix.json)[0].op, "add");
});

test("推断出来的字段必须显式标出来", () => {
	const ir = demoIR();
	const fix = buildIrFix(ir, {
		id: "a_901",
		entity: "Unknown",
		from: "submitted",
		action: "cancel",
		to: "cancelled",
		by: "manager",
		guards: [],
		verify: "",
		source: "代码：x.ts:1",
		status: "confirmed",
	});
	assert.ok(fix);
	assert.equal(fix.status, "assumed");
	assert.match(fix.note ?? "", /entity 推断/);
	assert.match(fix.note ?? "", /by 推断/);
});

test("多条 fix 能合成一份 change 载荷", () => {
	const a = buildIrFix(demoIR(), {
		id: "a_1",
		entity: "main",
		from: "submitted",
		action: "cancel",
		to: "cancelled",
		by: "manager",
		guards: [],
		verify: "",
		source: "代码：a.ts:1",
		status: "confirmed",
	});
	const b = buildIrFix(demoIR(), {
		id: "a_2",
		entity: "main",
		from: "submitted",
		action: "archive",
		to: "archived",
		by: "manager",
		guards: [],
		verify: "",
		source: "代码：a.ts:9",
		status: "confirmed",
	});
	const payload = JSON.parse(mergeFixes([a!, b!]));
	assert.equal(payload.length, 2);
	assert.equal(payload[1].assertion.action, "archive");
});

test("闭环：门禁失败 → 取建议 → 应用 → 门禁通过", async () => {
	const dir = workspace(CODE_WITH_CANCEL);
	try {
		const ir = demoIR();
		const before = await runGate(ir, { cwd: dir, repo: "service" });
		assert.equal(before.ok, false);
		const item = before.checks.find((c) => c.id === "drift")?.items[0];
		assert.ok(item?.fix, "应当给出反向建议");

		const payload = JSON.parse(mergeFixes([item.fix!]));
		const applied = applyChangeSet(ir, "补上代码里已有、IR 没确认的迁移", payload);
		assert.equal(applied.ok, true, applied.ok ? "" : applied.error);

		const after = await runGate(ir, { cwd: dir, repo: "service" });
		assert.equal(after.ok, true, JSON.stringify(after.checks, null, 2));
		assert.equal(validate(ir).stats.errors, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("补进去的那条会进断言清单，source 仍指向代码", async () => {
	const dir = workspace(CODE_WITH_CANCEL);
	try {
		const ir = demoIR();
		const before = await runGate(ir, { cwd: dir, repo: "service" });
		const fix = before.checks.find((c) => c.id === "drift")?.items[0]?.fix;
		assert.ok(fix);
		applyChangeSet(ir, "补", JSON.parse(mergeFixes([fix])));
		const added = ir.assertions.find((a) => a.action === "cancel");
		assert.ok(added);
		assert.match(added.source, /order\.controller\.ts:\d+/);
		assert.equal(added.by, "employee");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("YAML 里的特殊字符会被正确引用", () => {
	const ir = demoIR();
	const fix = buildIrFix(ir, {
		id: "a_902",
		entity: "main",
		from: "待审批",
		action: "cancel",
		to: "已取消",
		by: "manager",
		guards: [],
		verify: "",
		source: '代码：a.ts:1 "quoted"',
		status: "confirmed",
	});
	assert.ok(fix);
	assert.match(fix.yaml, /source: "代码：a\.ts:1 \\"quoted\\""/);
});
