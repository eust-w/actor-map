/**
 * 把 IR 编译成一个能跑的参考状态机。
 *
 * 这不是实现，而是一把尺子：coding agent 写完实现后，两边跑同一组
 * (当前状态, 动作, 上下文) 的输入，结论必须一致。
 * 解析不了的条件不猜，标成 unchecked —— 让调用方知道哪几处得人看。
 */
import { EMPTY_STATE } from "../ir/types.js";
import { parseGuard } from "../validate/guards.js";
export function exportRunner(ir) {
    const transitions = ir.assertions.map((a) => {
        const parsed = a.guards.map(parseGuard);
        return {
            id: a.id,
            entity: a.entity,
            from: a.from,
            action: a.action,
            to: a.to,
            by: a.by,
            guards: parsed.flatMap((p) => p.numeric),
            unchecked: parsed.flatMap((p) => p.unparsed),
            verify: a.verify,
        };
    });
    return `/**
 * ${ir.product} · 参考状态机 v${ir.version}
 * 由 ActorMap 从断言清单编译而来。不要改这个文件，改 IR 再重新导出。
 *
 *   import { can, apply, transitions, unchecked } from "./runner.mjs";
 *   can("draft", "submit", { 金额: 100 }, "employee")
 *   // → { allowed: true, to: "submitted", checks: [] }
 */
const TRANSITIONS = ${JSON.stringify(transitions, null, 2)};

const EMPTY = ${JSON.stringify(EMPTY_STATE)};

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
`;
}
