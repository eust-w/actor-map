/**
 * 变更集：改需求不是重写文档，是一次可追溯的差量。
 *
 * 每次变更都必须回答三件事：改了什么、谁受影响、要不要重测。
 * 影响面不靠人算 —— 靠校验器在变更前后各跑一次做差分。
 */
import { addAssertion } from "./store.js";
import { validate } from "../validate/validate.js";
function issueCounts(ir) {
    const result = validate(ir);
    const codes = {};
    for (const issue of result.issues)
        codes[issue.code] = (codes[issue.code] ?? 0) + 1;
    return { codes, errors: result.stats.errors };
}
function nextChangeSetId(ir) {
    const current = ir.changesets ?? [];
    let max = 0;
    for (const cs of current) {
        const m = cs.id.match(/^cs_(\d+)$/);
        if (m)
            max = Math.max(max, Number(m[1]));
    }
    return `cs_${String(max + 1).padStart(3, "0")}`;
}
function diffCounts(before, after, direction) {
    const out = [];
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
        const delta = (after[key] ?? 0) - (before[key] ?? 0);
        if (direction === "introduced" && delta > 0)
            out.push(`${key} +${delta}`);
        if (direction === "fixed" && delta < 0)
            out.push(`${key} ${delta}`);
    }
    return out;
}
export function applyChangeSet(ir, reason, changes) {
    if (changes.length === 0)
        return { ok: false, error: "变更集为空。" };
    const trimmedReason = reason.trim();
    if (!trimmedReason)
        return { ok: false, error: "变更必须写 reason：为什么改。半年后这条比改了什么更重要。" };
    const clone = structuredClone(ir);
    clone.changesets ??= [];
    clone.tombstones ??= [];
    const changeSetId = nextChangeSetId(clone);
    const at = new Date().toISOString();
    const before = issueCounts(clone);
    const touched = new Set();
    const touch = (entity, state) => {
        if (state)
            touched.add(`${entity}\u0000${state}`);
    };
    const actorsTouched = new Set();
    const added = [];
    const modified = [];
    const removed = [];
    const tasks = [];
    for (const change of changes) {
        if (change.op === "add") {
            const outcome = addAssertion(clone, change.assertion);
            if (!outcome.ok)
                return { ok: false, error: `新增失败：${outcome.error}` };
            added.push(outcome.assertion.id);
            touch(outcome.assertion.entity, outcome.assertion.from);
            touch(outcome.assertion.entity, outcome.assertion.to);
            actorsTouched.add(outcome.assertion.by);
            tasks.push(`新增契约测试：${outcome.assertion.id}（${outcome.assertion.from} --${outcome.assertion.action}--> ${outcome.assertion.to}）`);
            continue;
        }
        if (change.op === "ack_terminal") {
            const key = change.state.trim();
            if (!key)
                return { ok: false, error: "ack_terminal 需要一个状态名。" };
            if (!clone.terminals.includes(key))
                clone.terminals.push(key);
            continue;
        }
        const index = clone.assertions.findIndex((a) => a.id === change.id);
        if (index < 0)
            return { ok: false, error: `找不到断言 ${change.id}。` };
        const current = clone.assertions[index];
        if (change.op === "remove") {
            const tombstone = { assertion: current, at, reason: trimmedReason, changeSet: changeSetId };
            clone.tombstones.push(tombstone);
            clone.assertions.splice(index, 1);
            removed.push(current.id);
            touch(current.entity, current.from);
            touch(current.entity, current.to);
            actorsTouched.add(current.by);
            tasks.push(`删除契约测试：${current.id}（${current.from} --${current.action}--> ${current.to}）`);
            continue;
        }
        // modify
        const next = { ...current, ...change.patch };
        if (next.from !== current.from || next.action !== current.action) {
            const clash = clone.assertions.find((a) => a.id !== next.id && a.entity === next.entity && a.from === next.from && a.action === next.action);
            if (clash) {
                return {
                    ok: false,
                    error: `改完之后与 ${clash.id} 冲突：(${next.entity}, ${next.from}, ${next.action}) 只能有一个结果。`,
                };
            }
        }
        if (!clone.actors.some((a) => a.id === next.by)) {
            return { ok: false, error: `actor "${next.by}" 未登记。` };
        }
        clone.assertions[index] = next;
        modified.push(next.id);
        touch(current.entity, current.from);
        touch(current.entity, current.to);
        touch(next.entity, next.from);
        touch(next.entity, next.to);
        actorsTouched.add(next.by);
        tasks.push(`更新契约测试：${next.id}`);
        // 同一状态上的其它分支可能被这次改动影响
        const siblings = clone.assertions.filter((a) => a.id !== next.id && a.entity === next.entity && a.from === next.from);
        if (siblings.length > 0) {
            tasks.push(`复核 ${next.from} 下另外 ${siblings.length} 条分支是否仍成立：${siblings.map((s) => s.action).join("、")}`);
        }
    }
    const after = issueCounts(clone);
    clone.version += 1;
    const referenced = new Set();
    for (const a of clone.assertions) {
        referenced.add(`${a.entity}\u0000${a.from}`);
        referenced.add(`${a.entity}\u0000${a.to}`);
    }
    const vanished = [...touched]
        .filter((key) => !referenced.has(key))
        .map((key) => key.split("\u0000")[1])
        .filter((state, i, all) => all.indexOf(state) === i);
    const impact = {
        added,
        modified,
        removed,
        statesTouched: [...new Set([...touched].map((key) => key.split("\u0000")[1]))],
        actorsTouched: [...actorsTouched],
        vanished,
        tasks,
        issuesBefore: before.codes,
        issuesAfter: after.codes,
        fixed: diffCounts(before.codes, after.codes, "fixed"),
        introduced: diffCounts(before.codes, after.codes, "introduced"),
        errorsBefore: before.errors,
        errorsAfter: after.errors,
    };
    const changeSet = { id: changeSetId, at, reason: trimmedReason, changes };
    clone.changesets.push(changeSet);
    // 原地替换，保持引用兼容
    ir.product = clone.product;
    ir.version = clone.version;
    ir.actors = clone.actors;
    ir.assertions = clone.assertions;
    ir.terminals = clone.terminals;
    ir.tombstones = clone.tombstones;
    ir.changesets = clone.changesets;
    return { ok: true, changeSet, impact };
}
export function formatImpact(changeSet, impact) {
    const lines = [];
    const parts = [];
    if (impact.added.length)
        parts.push(`+${impact.added.length}`);
    if (impact.modified.length)
        parts.push(`~${impact.modified.length}`);
    if (impact.removed.length)
        parts.push(`-${impact.removed.length}`);
    lines.push(`${changeSet.id} 已应用（${parts.join(" ") || "无断言变化"}）：${changeSet.reason}`);
    if (impact.statesTouched.length)
        lines.push(`受影响状态：${impact.statesTouched.join("、")}`);
    if (impact.actorsTouched.length)
        lines.push(`受影响角色：${impact.actorsTouched.join("、")}`);
    if (impact.vanished.length)
        lines.push(`⚠ 不再被引用的状态：${impact.vanished.join("、")}`);
    if (impact.fixed.length)
        lines.push(`已消除：${impact.fixed.join("，")}`);
    if (impact.introduced.length)
        lines.push(`新引入：${impact.introduced.join("，")}`);
    if (impact.tasks.length)
        lines.push(`后续动作：\n${impact.tasks.map((t) => `  · ${t}`).join("\n")}`);
    lines.push(`错误数：${impact.errorsBefore} → ${impact.errorsAfter}`);
    return lines.join("\n");
}
