/**
 * 条件推理：把 `金额 > 5000` 这类 guard 解析成区间，找出分支之间的重叠和空洞。
 *
 * 这是最能体现"地图可验证"的一步：需求里最常见的缺陷不是写错，而是
 * 「5000 到 8000 之间没人管」—— 没人会主动说这句话，但它一定会变成线上 bug。
 */
const NUMERIC = /^-?\d+(?:\.\d+)?$/;
export function parseGuard(guard) {
    const parts = guard
        .split(/&&|&|\band\b|、|,/)
        .map((p) => p.trim())
        .filter(Boolean);
    const numeric = [];
    const unparsed = [];
    for (const part of parts) {
        const m = part.match(/^(.+?)\s*(<=|>=|==|!=|<|>)\s*(.+)$/);
        if (!m) {
            unparsed.push(part);
            continue;
        }
        const variable = m[1].trim();
        const op = m[2];
        const raw = m[3].trim().replace(/^["']|["']$/g, "");
        if (op === "!=" || !NUMERIC.test(raw) || /[+\-*/()]/.test(variable)) {
            unparsed.push(part);
            continue;
        }
        numeric.push({ variable, op, value: Number(raw) });
    }
    return { numeric, unparsed };
}
export function toInterval(comparisons) {
    let interval = { lo: Number.NEGATIVE_INFINITY, loInc: false, hi: Number.POSITIVE_INFINITY, hiInc: false, universal: true };
    for (const c of comparisons) {
        interval.universal = false;
        switch (c.op) {
            case ">":
                if (c.value >= interval.lo)
                    interval = { ...interval, lo: c.value, loInc: false };
                break;
            case ">=":
                if (c.value > interval.lo)
                    interval = { ...interval, lo: c.value, loInc: true };
                break;
            case "<":
                if (c.value <= interval.hi)
                    interval = { ...interval, hi: c.value, hiInc: false };
                break;
            case "<=":
                if (c.value < interval.hi)
                    interval = { ...interval, hi: c.value, hiInc: true };
                break;
            case "==":
                interval = { ...interval, lo: c.value, loInc: true, hi: c.value, hiInc: true };
                break;
            default:
                // != 不是区间，交给 unparsed 处理
                break;
        }
    }
    return interval;
}
function isEmpty(i) {
    if (i.lo > i.hi)
        return true;
    if (i.lo === i.hi && !(i.loInc && i.hiInc))
        return true;
    return false;
}
function overlaps(a, b) {
    if (a.universal || b.universal)
        return true;
    const lo = Math.max(a.lo, b.lo);
    const hi = Math.min(a.hi, b.hi);
    if (lo < hi)
        return true;
    if (lo > hi)
        return false;
    const loInc = a.lo === lo ? a.loInc : b.loInc;
    const hiInc = a.hi === hi ? a.hiInc : b.hiInc;
    return loInc && hiInc;
}
function fmt(n) {
    if (n === Number.NEGATIVE_INFINITY)
        return "-∞";
    if (n === Number.POSITIVE_INFINITY)
        return "+∞";
    return String(n);
}
/** 合并后的空隙 */
function gaps(intervals) {
    const solid = intervals.filter((i) => !i.universal && !isEmpty(i)).sort((a, b) => a.lo - b.lo);
    if (solid.length === 0)
        return [];
    const result = [];
    let cursor = solid[0];
    if (cursor.lo > Number.NEGATIVE_INFINITY) {
        result.push({ lo: Number.NEGATIVE_INFINITY, loInc: false, hi: cursor.lo, hiInc: !cursor.loInc });
    }
    for (const next of solid.slice(1)) {
        const touching = next.lo < cursor.hi || (next.lo === cursor.hi && (next.loInc || cursor.hiInc));
        if (touching) {
            if (next.hi > cursor.hi)
                cursor = next;
            continue;
        }
        result.push({ lo: cursor.hi, loInc: !cursor.hiInc, hi: next.lo, hiInc: !next.loInc });
        cursor = next;
    }
    if (cursor.hi < Number.POSITIVE_INFINITY) {
        result.push({ lo: cursor.hi, loInc: !cursor.hiInc, hi: Number.POSITIVE_INFINITY, hiInc: false });
    }
    return result;
}
function edgeLabel(a) {
    return `${a.action}→${a.to}`;
}
export function checkGuards(ir, graphs) {
    const issues = [];
    const byId = new Map(ir.assertions.map((a) => [a.id, a]));
    for (const graph of graphs) {
        for (const state of graph.states) {
            const edges = graph.out.get(state) ?? [];
            if (edges.length < 2)
                continue;
            // 1) 每条分支自身的条件是否自相矛盾
            const parsed = edges.map((edge) => {
                const parts = edge.guards.map(parseGuard);
                const numeric = parts.flatMap((p) => p.numeric);
                const unparsed = parts.flatMap((p) => p.unparsed);
                return { edge, numeric, unparsed };
            });
            for (const item of parsed) {
                const byVariable = groupBy(item.numeric);
                for (const [variable, comparisons] of byVariable) {
                    if (isEmpty(toInterval(comparisons))) {
                        issues.push({
                            code: "unsatisfiable_guard",
                            severity: "error",
                            entity: graph.entity,
                            refs: [item.edge.id],
                            message: `${graph.entity} 的 ${edgeLabel(item.edge)} 条件互相矛盾：${variable} 不可能同时满足 ${comparisons.map((c) => `${c.op}${c.value}`).join(" 和 ")}。`,
                            question: `${item.edge.action} 的触发条件写矛盾了，实际应该是什么？`,
                        });
                    }
                }
            }
            // 2) 同一状态下、同一变量上，分支之间的重叠与空洞
            const variables = new Set();
            for (const item of parsed)
                for (const c of item.numeric)
                    variables.add(c.variable);
            for (const variable of variables) {
                const intervals = parsed.map((item) => {
                    const forVar = item.numeric.filter((c) => c.variable === variable);
                    return {
                        edge: item.edge,
                        interval: toInterval(forVar),
                        hasConstraint: forVar.length > 0,
                        unparsed: item.unparsed,
                        /** 条件存在但解析不了（时间表达式、函数调用…），不能当成“无条件” */
                        unknown: forVar.length === 0 && item.unparsed.length > 0,
                    };
                });
                for (let i = 0; i < intervals.length; i += 1) {
                    for (let j = i + 1; j < intervals.length; j += 1) {
                        const a = intervals[i];
                        const b = intervals[j];
                        if (a.unknown || b.unknown)
                            continue;
                        if (a.interval.universal && b.interval.universal)
                            continue;
                        if (!overlaps(a.interval, b.interval))
                            continue;
                        const unguarded = a.interval.universal || b.interval.universal;
                        issues.push({
                            code: "branch_overlap",
                            severity: unguarded ? "warn" : "error",
                            entity: graph.entity,
                            refs: [a.edge.id, b.edge.id],
                            message: unguarded
                                ? `${graph.entity} 的 "${state}"：${edgeLabel(a.edge)} 与 ${edgeLabel(b.edge)} 会同时成立（其中一条没有条件）。`
                                : `${graph.entity} 的 "${state}"：${edgeLabel(a.edge)} 与 ${edgeLabel(b.edge)} 的 ${variable} 区间重叠。`,
                            question: `当 ${variable} 落在两边都满足的区间时，系统走哪一条？需要补一个更细的条件。`,
                        });
                    }
                }
                const constrained = intervals.filter((i) => i.hasConstraint || i.unknown);
                if (constrained.length < edges.length)
                    continue;
                if (constrained.some((i) => i.unknown || i.interval.universal))
                    continue;
                for (const gap of gaps(constrained.map((i) => i.interval))) {
                    const lo = gap.loInc ? "[" : "(";
                    const hi = gap.hiInc ? "]" : ")";
                    const range = gap.lo === Number.NEGATIVE_INFINITY
                        ? `${variable} ${gap.hiInc ? "<=" : "<"} ${fmt(gap.hi)}`
                        : gap.hi === Number.POSITIVE_INFINITY
                            ? `${variable} ${gap.loInc ? ">=" : ">"} ${fmt(gap.lo)}`
                            : `${fmt(gap.lo)}${lo === "[" ? "≤" : "<"} ${variable} ${hi === "]" ? "≤" : "<"} ${fmt(gap.hi)}`;
                    issues.push({
                        code: "branch_gap",
                        severity: "warn",
                        entity: graph.entity,
                        refs: edges.map((e) => e.id),
                        message: `${graph.entity} 的 "${state}"：${range} 这一段没有任何分支覆盖（区间 ${lo}${fmt(gap.lo)}, ${fmt(gap.hi)}${hi}）。`,
                        question: `${range} 的时候，这张单子会怎样？是谁来处理？`,
                    });
                }
            }
            // 3) 同一个动作名在不同分支上指向不同结果
            const actionTargets = new Map();
            for (const edge of edges) {
                const set = actionTargets.get(edge.action) ?? new Set();
                set.add(edge.to);
                actionTargets.set(edge.action, set);
            }
            for (const [action, targets] of actionTargets) {
                if (targets.size > 1) {
                    issues.push({
                        code: "action_semantics_conflict",
                        severity: "warn",
                        entity: graph.entity,
                        refs: edges.filter((e) => e.action === action).map((e) => e.id),
                        message: `${graph.entity} 的 "${state}"：同一个动作 ${action} 会走向 ${[...targets].join(" / ")}。`,
                        question: `${action} 到底是一个动作还是两个？如果是两个，请分别命名（比如 approve / escalate）。`,
                    });
                }
            }
        }
    }
    // 4) 跨状态的同名动作指向太多不同结果，通常是命名偷懒
    const actionTargets = new Map();
    for (const a of ir.assertions) {
        const set = actionTargets.get(a.action) ?? new Set();
        set.add(a.to);
        actionTargets.set(a.action, set);
    }
    for (const [action, targets] of actionTargets) {
        if (targets.size >= 3) {
            issues.push({
                code: "action_semantics_conflict",
                severity: "warn",
                entity: "-",
                refs: ir.assertions.filter((a) => a.action === action).map((a) => a.id),
                message: `动作名 ${action} 在 ${targets.size} 个地方指向不同结果：${[...targets].join(" / ")}。`,
                question: `${action} 这个名字下面其实是几种不同操作？需要拆开命名。`,
            });
        }
    }
    // 5) 同一状态下同一动作被多个角色发起（且条件重叠）
    for (const graph of graphs) {
        for (const state of graph.states) {
            const edges = graph.out.get(state) ?? [];
            const byAction = new Map();
            for (const e of edges) {
                const list = byAction.get(e.action) ?? [];
                list.push(e);
                byAction.set(e.action, list);
            }
            for (const [action, list] of byAction) {
                const actors = new Set(list.map((e) => e.by));
                if (actors.size > 1) {
                    issues.push({
                        code: "ambiguous_owner",
                        severity: "warn",
                        entity: graph.entity,
                        refs: list.map((e) => e.id),
                        message: `${graph.entity} 的 "${state}" 下 ${action} 有 ${actors.size} 个发起者：${[...actors].join(" / ")}。`,
                        question: `${action} 是两个人谁点都算，还是各有一套流程？`,
                    });
                }
            }
        }
    }
    // 清掉指不到的 refs（防御）
    for (const issue of issues)
        issue.refs = issue.refs.filter((r) => r === "-" || byId.has(r) || r.length > 0);
    return issues;
}
function groupBy(comparisons) {
    const map = new Map();
    for (const c of comparisons) {
        const list = map.get(c.variable) ?? [];
        list.push(c);
        map.set(c.variable, list);
    }
    return map;
}
