/**
 * 报销系统 · 参考状态机 v7
 * 由 ActorMap 从断言清单编译而来。不要改这个文件，改 IR 再重新导出。
 *
 *   import { can, apply, transitions, unchecked } from "./runner.mjs";
 *   can("draft", "submit", { 金额: 100 }, "employee")
 *   // → { allowed: true, to: "submitted", checks: [] }
 */
const TRANSITIONS = [
  {
    "id": "a_001",
    "entity": "order",
    "from": "∅",
    "action": "create",
    "to": "draft",
    "by": "employee",
    "guards": [],
    "unchecked": [],
    "verify": "单据出现在「我的报销」列表"
  },
  {
    "id": "a_002",
    "entity": "order",
    "from": "draft",
    "action": "submit",
    "to": "submitted",
    "by": "employee",
    "guards": [
      {
        "variable": "金额",
        "op": ">",
        "value": 0
      }
    ],
    "unchecked": [
      "已上传发票"
    ],
    "verify": "单据出现在主管待办"
  },
  {
    "id": "a_003",
    "entity": "order",
    "from": "submitted",
    "action": "approve",
    "to": "approved",
    "by": "manager",
    "guards": [
      {
        "variable": "金额",
        "op": "<=",
        "value": 5000
      }
    ],
    "unchecked": [],
    "verify": "状态变为已通过"
  },
  {
    "id": "a_004",
    "entity": "order",
    "from": "submitted",
    "action": "escalate",
    "to": "pending_finance",
    "by": "manager",
    "guards": [
      {
        "variable": "金额",
        "op": ">",
        "value": 5000
      }
    ],
    "unchecked": [],
    "verify": "单据进入财务复核队列"
  },
  {
    "id": "a_005",
    "entity": "order",
    "from": "submitted",
    "action": "reject",
    "to": "draft",
    "by": "manager",
    "guards": [],
    "unchecked": [
      "发票不合规"
    ],
    "verify": "回到员工草稿，金额不可改"
  },
  {
    "id": "a_006",
    "entity": "order",
    "from": "approved",
    "action": "pay",
    "to": "paid",
    "by": "finance",
    "guards": [],
    "unchecked": [],
    "verify": "生成打款回执"
  },
  {
    "id": "a_007",
    "entity": "order",
    "from": "pending_finance",
    "action": "confirm",
    "to": "approved",
    "by": "finance",
    "guards": [],
    "unchecked": [],
    "verify": "进入待打款"
  },
  {
    "id": "a_008",
    "entity": "order",
    "from": "submitted",
    "action": "auto_close",
    "to": "closed",
    "by": "sweeper",
    "guards": [],
    "unchecked": [
      "now - submitted_at > 30d"
    ],
    "verify": "状态变为已关闭，双方各收一条通知"
  }
];

const EMPTY = "∅";

function test(ctx, guard) {
	if (typeof ctx === "undefined" || ctx === null) return false;
	const raw = ctx[guard.variable];
	if (typeof raw !== "number") return false;
	switch (guard.op) {
		case "<": return raw < guard.value;
		case "<=": return raw <= guard.value;
		case ">": return raw > guard.value;
		case ">=": return raw >= guard.value;
		case "==": return raw === guard.value;
		case "!=": return raw !== guard.value;
		default: return false;
	}
}

export function can(from, action, ctx, by) {
	return TRANSITIONS.filter(
		(t) => t.from === from && t.action === action && (!by || t.by === by),
	);
}

export function apply(from, action, ctx, by) {
	const candidates = can(from, action, ctx, by);
	const hit = candidates.filter((t) => t.guards.every((g) => test(ctx, g)));
	if (hit.length === 0) {
		return { allowed: false, reason: candidates.length === 0 ? "no-such-transition" : "guard-rejected", to: null };
	}
	// 同一状态同一动作只应有一个结果；多于一个说明 IR 本身不自洽
	if (hit.length > 1) {
		return { allowed: false, reason: "ambiguous", to: null, candidates: hit.map((t) => t.id) };
	}
	const t = hit[0];
	return { allowed: true, to: t.to, id: t.id, verify: t.verify, checks: t.unchecked };
}

export function create(entity, by) {
	return can(EMPTY, "create", {}, by).filter((t) => t.entity === entity)[0]?.to ?? null;
}

export { TRANSITIONS as transitions };

export const unchecked = [
	...new Set(TRANSITIONS.flatMap((t) => t.unchecked.map((u) => t.id + ": " + u))),
];
