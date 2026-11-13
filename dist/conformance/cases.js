/**
 * 从断言推导契约用例。
 *
 * 每条断言产出：
 *   positive        —— 条件刚好满足，必须成功，且落到 to
 *   guard-negative  —— 逐个把条件破坏掉，必须被拒且状态不变
 *   actor-negative  —— 换个角色来点，必须被拒
 *
 * 取值一律用边界值（<=5000 用 5000 / 5001）。差一错误是需求实现里最高频的 bug，
 * 也只有边界值能抓到。
 */
import { EMPTY_STATE } from "../ir/types.js";
import { parseGuard } from "../validate/guards.js";
/** 让一条比较成立的值；取边界 */
function satisfying(comparison) {
    const v = comparison.value;
    switch (comparison.op) {
        case "<":
            return v - 1;
        case "<=":
            return v;
        case ">":
            return v + 1;
        case ">=":
            return v;
        case "==":
            return v;
        default:
            return v;
    }
}
/** 让一条比较不成立的值；同样取边界 */
function violating(comparison) {
    const v = comparison.value;
    switch (comparison.op) {
        case "<":
            return v;
        case "<=":
            return v + 1;
        case ">":
            return v - 1;
        case ">=":
            return v;
        case "==":
            return v + 1;
        default:
            return v;
    }
}
export function deriveCases(ir) {
    const cases = [];
    const skipped = [];
    // 每个 (entity, from) 上出现过的角色，用来造角色反例
    const actorsAt = new Map();
    for (const a of ir.assertions) {
        const key = `${a.entity}|${a.from}`;
        const set = actorsAt.get(key) ?? new Set();
        set.add(a.by);
        actorsAt.set(key, set);
    }
    for (const a of ir.assertions) {
        const parsed = a.guards.map(parseGuard);
        const numeric = parsed.flatMap((p) => p.numeric);
        const unparsed = parsed.flatMap((p) => p.unparsed);
        if (unparsed.length > 0) {
            skipped.push({
                assertionId: a.id,
                reason: `条件里有解析不了的表达式（${unparsed.join("、")}），参考状态机也不判断它，跳过`,
            });
            continue;
        }
        // 每个变量取一个满足值
        const base = {};
        for (const c of numeric)
            base[c.variable] = satisfying(c);
        cases.push({
            id: `${a.id}-pos`,
            assertionId: a.id,
            kind: "positive",
            entity: a.entity,
            from: a.from,
            action: a.action,
            to: a.to,
            by: a.by,
            ctx: { ...base },
            expectAllowed: true,
            expectTo: a.to,
        });
        // 逐个条件破坏
        for (const [index, c] of numeric.entries()) {
            const ctx = { ...base, [c.variable]: violating(c) };
            // 破坏一个变量后可能顺带破坏了同一变量上的另一条比较，那这条反例就没意义
            if (numeric.some((other) => other !== c && other.variable === c.variable && !holds(ctx, other))) {
                continue;
            }
            cases.push({
                id: `${a.id}-neg${index + 1}`,
                assertionId: a.id,
                kind: "guard-negative",
                entity: a.entity,
                from: a.from,
                action: a.action,
                to: a.to,
                by: a.by,
                ctx,
                expectAllowed: false,
                note: `让 ${c.variable} ${c.op} ${c.value} 不成立`,
            });
        }
        // 换个角色来做同一件事。优先用同一状态上别的角色，没有就随便找个别的角色 ——
        // 「不该能做这件事的人能不能做」比「同一个状态上谁还能做」更能抓权限漏检
        const sameState = [...(actorsAt.get(`${a.entity}|${a.from}`) ?? [])].filter((by) => by !== a.by);
        const anyOther = ir.actors.filter((actor) => actor.id !== a.by).map((actor) => actor.id);
        const intruder = sameState[0] ?? anyOther[0];
        if (intruder) {
            cases.push({
                id: `${a.id}-actor`,
                assertionId: a.id,
                kind: "actor-negative",
                entity: a.entity,
                from: a.from,
                action: a.action,
                to: a.to,
                by: intruder,
                ctx: { ...base },
                expectAllowed: false,
                note: `${intruder} 不是这条迁移的发起者`,
            });
        }
    }
    return { cases, skipped };
}
function holds(ctx, c) {
    const value = ctx[c.variable];
    if (typeof value !== "number")
        return false;
    switch (c.op) {
        case "<":
            return value < c.value;
        case "<=":
            return value <= c.value;
        case ">":
            return value > c.value;
        case ">=":
            return value >= c.value;
        case "==":
            return value === c.value;
        case "!=":
            return value !== c.value;
        default:
            return false;
    }
}
/** 从 ∅ 走到目标状态的动作序列（用于让实现自己把对象推进到前置状态） */
export function pathTo(ir, entity, target) {
    if (target === EMPTY_STATE)
        return [];
    const edges = ir.assertions.filter((a) => a.entity === entity);
    const queue = [EMPTY_STATE];
    const prev = new Map();
    const seen = new Set([EMPTY_STATE]);
    while (queue.length > 0) {
        const state = queue.shift();
        if (state === target)
            break;
        for (const edge of edges.filter((e) => e.from === state)) {
            if (seen.has(edge.to))
                continue;
            // 解析不了的条件（如「已上传发票」）不阻止开路：真拒绝了会在 setup 阶段暴露成 skip
            const parsed = edge.guards.map(parseGuard);
            const ctx = {};
            for (const c of parsed.flatMap((p) => p.numeric))
                ctx[c.variable] = satisfying(c);
            seen.add(edge.to);
            prev.set(edge.to, { from: state, action: edge.action, by: edge.by, ctx });
            queue.push(edge.to);
        }
    }
    if (!seen.has(target))
        return null;
    const steps = [];
    let cursor = target;
    while (cursor !== EMPTY_STATE) {
        const step = prev.get(cursor);
        if (!step)
            return null;
        steps.unshift({ action: step.action, by: step.by, ctx: step.ctx });
        cursor = step.from;
    }
    return steps;
}
