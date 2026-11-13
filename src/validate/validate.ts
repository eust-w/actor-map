/**
 * 校验器：零 LLM，纯图算法。
 *
 * 它不"理解"需求，只回答一个问题：这张图作为状态机是否自洽。
 * 每条 issue 都带一句「该问什么」，所以校验的产出直接就是下一轮访谈的输入。
 */

import type { Assertion, IRFile } from "../ir/types.ts";
import { EMPTY_STATE, terminalKey } from "../ir/types.ts";
import { checkGuards } from "./guards.ts";

export type Severity = "error" | "warn";

export type IssueCode =
	| "empty_ir"
	| "unknown_actor"
	| "orphan_actor"
	| "actor_without_trigger"
	| "ambiguous_transition"
	| "no_entry"
	| "implicit_entry"
	| "unreachable_state"
	| "no_terminal_path"
	| "loop_without_exit"
	| "unconfirmed_terminal"
	| "missing_source"
	| "unguarded_branch"
	| "self_loop"
	| "branch_overlap"
	| "branch_gap"
	| "unsatisfiable_guard"
	| "action_semantics_conflict"
	| "ambiguous_owner";

export interface Issue {
	code: IssueCode;
	severity: Severity;
	entity: string;
	refs: string[];
	message: string;
	/** 直接可以拿去问人的一句话 */
	question: string;
}

export interface EntityGraph {
	entity: string;
	states: string[];
	/** 由 `∅ --create--> x` 声明的入口；没声明时退化为「入度为 0」的推断 */
	initial: string[];
	/** 入口是推断出来的，还没被人确认 */
	implicitEntry: boolean;
	/** 声明的 ∪ 推导出的（没有出边） */
	terminal: string[];
	/** 只是推导出来、还没被人确认的终态 */
	inferredTerminal: string[];
	out: Map<string, Assertion[]>;
	in: Map<string, Assertion[]>;
}

export interface ValidationResult {
	issues: Issue[];
	graphs: EntityGraph[];
	stats: {
		entities: number;
		states: number;
		assertions: number;
		confirmed: number;
		assumed: number;
		errors: number;
		warnings: number;
		actors: number;
	};
}

export function buildGraphs(ir: IRFile): EntityGraph[] {
	const byEntity = new Map<string, Assertion[]>();
	for (const a of ir.assertions) {
		const list = byEntity.get(a.entity) ?? [];
		list.push(a);
		byEntity.set(a.entity, list);
	}
	const graphs: EntityGraph[] = [];

	for (const [entity, edges] of byEntity) {
		const declared = new Set<string>(ir.terminals);
		const isDeclared = (state: string) =>
			declared.has(terminalKey(entity, state)) || declared.has(state);

		const states = new Set<string>();
		const out = new Map<string, Assertion[]>();
		const inMap = new Map<string, Assertion[]>();
		const created: string[] = [];

		for (const e of edges) {
			if (e.from === EMPTY_STATE) {
				if (e.to !== EMPTY_STATE) created.push(e.to);
				continue;
			}
			states.add(e.from);
			states.add(e.to);
			const o = out.get(e.from) ?? [];
			o.push(e);
			out.set(e.from, o);
			const i = inMap.get(e.to) ?? [];
			i.push(e);
			inMap.set(e.to, i);
		}

		// 创建边的目标也是状态。否则「只有 ∅ --create--> draft」这种刚起步的 IR
		// 会被当成空图，什么缺口都报不出来 —— 而那正是访谈刚开始的时刻。
		for (const target of created) states.add(target);

		const all = [...states].sort();
		const implicitEntry = created.length === 0;
		const entryPool = implicitEntry ? all.filter((s) => s !== EMPTY_STATE) : created;
		const initial = implicitEntry
			? entryPool.filter((s) => (inMap.get(s)?.length ?? 0) === 0)
			: [...new Set(entryPool)];
		const sinks = all.filter((s) => (out.get(s)?.length ?? 0) === 0);
		const declaredHere = all.filter(isDeclared);
		const inferredTerminal = sinks.filter((s) => s !== EMPTY_STATE && !isDeclared(s));

		graphs.push({
			entity,
			states: all,
			initial: initial.sort(),
			implicitEntry,
			terminal: [...new Set([...declaredHere, ...sinks])].sort(),
			inferredTerminal,
			out,
			in: inMap,
		});
	}
	return graphs;
}

export function validate(ir: IRFile): ValidationResult {
	const issues: Issue[] = [];
	const graphs = buildGraphs(ir);

	if (ir.assertions.length === 0) {
		issues.push({
			code: "empty_ir",
			severity: "error",
			entity: "-",
			refs: [],
			message: "还没有任何断言。",
			question: "先从「谁、在什么状态下、做了什么、变成什么」开始讲一条。",
		});
	}

	const actorIds = new Set(ir.actors.map((a) => a.id));

	for (const a of ir.assertions) {
		if (!actorIds.has(a.by)) {
			issues.push({
				code: "unknown_actor",
				severity: "error",
				entity: a.entity,
				refs: [a.id],
				message: `${a.id} 的发起者 "${a.by}" 不在 actor 表里。`,
				question: `"${a.by}" 是产品里的真实角色吗？还是应该归到已有角色下？`,
			});
		}
		if (!a.source.trim()) {
			issues.push({
				code: "missing_source",
				severity: "warn",
				entity: a.entity,
				refs: [a.id],
				message: `${a.id}（${a.from} --${a.action}--> ${a.to}）没有原话依据。`,
				question: "这条是从哪句话里得到的？没有的话请确认它真的存在。",
			});
		}
		if (a.from === a.to) {
			issues.push({
				code: "self_loop",
				severity: "warn",
				entity: a.entity,
				refs: [a.id],
				message: `${a.id} 是自我迁移（${a.from} --${a.action}--> ${a.from}）。`,
				question: `${a.action} 失败会一直重试吗？有没有次数上限或放弃条件？`,
			});
		}
	}

	for (const actor of ir.actors) {
		if (!ir.assertions.some((a) => a.by === actor.id)) {
			issues.push({
				code: "orphan_actor",
				severity: "warn",
				entity: "-",
				refs: [actor.id],
				message: `角色 ${actor.name}(${actor.id}) 没有任何发起的动作。`,
				question: `${actor.name} 在这条流程里能做什么？还是只读，或者根本不该出现在角色表里？`,
			});
		}
		if ((actor.type === "system" || actor.type === "external") && !actor.trigger?.trim()) {
			issues.push({
				code: "actor_without_trigger",
				severity: "warn",
				entity: "-",
				refs: [actor.id],
				message: `${actor.name}(${actor.id}) 是 ${actor.type}，但没有写触发条件。`,
				question: `${actor.name} 什么时候会动？是定时、还是被某个外部事件叫醒？`,
			});
		}
	}

	// 同一 (entity, from, action) 只能有一个结果
	const seen = new Map<string, Assertion>();
	for (const a of ir.assertions) {
		const key = `${a.entity}|${a.from}|${a.action}`;
		const prev = seen.get(key);
		if (prev) {
			issues.push({
				code: "ambiguous_transition",
				severity: "error",
				entity: a.entity,
				refs: [prev.id, a.id],
				message: `${a.entity} 的 ${a.from} --${a.action}--> 有两条结果：${prev.to} 和 ${a.to}。`,
				question: `${a.from} 状态下点「${a.action}」到底会发生哪一种？两种都要保留的话，区别条件是什么？`,
			});
		} else {
			seen.set(key, a);
		}
	}

	for (const g of graphs) {
		if (g.initial.length === 0) {
			issues.push({
				code: "no_entry",
				severity: "error",
				entity: g.entity,
				refs: g.states,
				message: `${g.entity} 找不到入口状态：每个状态都是别人的结果。`,
				question: `一个全新的 ${g.entity} 是从哪个状态开始的？谁创建的？`,
			});
		} else if (g.implicitEntry) {
			issues.push({
				code: "implicit_entry",
				severity: "warn",
				entity: g.entity,
				refs: g.initial,
				message: `${g.entity} 的入口是推断的：${g.initial.join(" / ")}，没有记录创建动作。`,
				question: `${g.entity} 是怎么被创建出来的？谁创建、在什么条件下？`,
			});
		}

		// 可达性
		if (g.initial.length > 0) {
			const reached = new Set<string>();
			const queue = [...g.initial];
			while (queue.length) {
				const s = queue.shift() as string;
				if (reached.has(s)) continue;
				reached.add(s);
				for (const e of g.out.get(s) ?? []) if (!reached.has(e.to)) queue.push(e.to);
			}
			for (const s of g.states) {
				if (!reached.has(s)) {
					issues.push({
						code: "unreachable_state",
						severity: "error",
						entity: g.entity,
						refs: [s],
						message: `${g.entity} 的状态 "${s}" 从入口走不到。`,
						question: `"${s}" 这个状态是怎么产生的？是不是漏了一条能走到它的迁移？`,
					});
				}
			}
		}

		// 终态可达性（反向）
		const canReachTerminal = new Set<string>(g.terminal);
		let changed = true;
		while (changed) {
			changed = false;
			for (const s of g.states) {
				if (canReachTerminal.has(s)) continue;
				if ((g.out.get(s) ?? []).some((e) => canReachTerminal.has(e.to))) {
					canReachTerminal.add(s);
					changed = true;
				}
			}
		}
		for (const s of g.states) {
			if (!canReachTerminal.has(s)) {
				issues.push({
					code: "no_terminal_path",
					severity: "error",
					entity: g.entity,
					refs: [s],
					message: `${g.entity} 的 "${s}" 走到头也到不了任何终态。`,
					question: `"${s}" 最后怎么结束？用户会不会永远卡在这一步？`,
				});
			}
		}

		// 环没有出口
		const adjacency = new Map<string, string[]>();
		for (const s of g.states) adjacency.set(s, (g.out.get(s) ?? []).map((e) => e.to));
		for (const component of strongComponents(g.states, adjacency)) {
			const isLoop = component.length > 1 || (g.out.get(component[0]) ?? []).some((e) => e.to === component[0]);
			if (!isLoop) continue;
			const member = new Set(component);
			const escapes = component.some((s) => (g.out.get(s) ?? []).some((e) => !member.has(e.to)));
			if (!escapes) {
				issues.push({
					code: "loop_without_exit",
					severity: "error",
					entity: g.entity,
					refs: component,
					message: `${g.entity} 的 ${component.join(" ⇄ ")} 构成闭环，没有出口。`,
					question: `这一圈什么时候会停？需要加一个什么条件才能走出去？`,
				});
			}
		}

		// 分支条件缺失
		for (const s of g.states) {
			const edges = g.out.get(s) ?? [];
			if (edges.length >= 2 && edges.every((e) => e.guards.length === 0)) {
				issues.push({
					code: "unguarded_branch",
					severity: "warn",
					entity: g.entity,
					refs: edges.map((e) => e.id),
					message: `${g.entity} 的 "${s}" 有 ${edges.length} 条分支，但都没有条件。`,
					question: `什么时候走 ${edges.map((e) => e.action).join("、")} 里的哪一条？判断依据是什么？`,
				});
			}
		}

		// 未确认的终态
		for (const s of g.inferredTerminal) {
			issues.push({
				code: "unconfirmed_terminal",
				severity: "warn",
				entity: g.entity,
				refs: [s],
				message: `${g.entity} 的 "${s}" 没有任何后续动作，被推定为终态。`,
				question: `"${s}" 是终点吗？还是后面还有动作没说？`,
			});
		}
	}

	issues.push(...checkGuards(ir, graphs));

	const errors = issues.filter((i) => i.severity === "error").length;	return {
		issues,
		graphs,
		stats: {
			entities: graphs.length,
			states: graphs.reduce((n, g) => n + g.states.length, 0),
			assertions: ir.assertions.length,
			confirmed: ir.assertions.filter((a) => a.status === "confirmed").length,
			assumed: ir.assertions.filter((a) => a.status === "assumed").length,
			errors,
			warnings: issues.length - errors,
			actors: ir.actors.length,
		},
	};
}

/** 迭代版 Tarjan：避免大图上爆栈。 */
function strongComponents(nodes: string[], adjacency: Map<string, string[]>): string[][] {
	let index = 0;
	const indices = new Map<string, number>();
	const low = new Map<string, number>();
	const onStack = new Set<string>();
	const stack: string[] = [];
	const result: string[][] = [];

	for (const start of nodes) {
		if (indices.has(start)) continue;
		const work: Array<{ node: string; next: number }> = [{ node: start, next: 0 }];
		indices.set(start, index);
		low.set(start, index);
		index += 1;
		stack.push(start);
		onStack.add(start);

		while (work.length > 0) {
			const frame = work[work.length - 1];
			const children = adjacency.get(frame.node) ?? [];
			if (frame.next < children.length) {
				const child = children[frame.next];
				frame.next += 1;
				if (!indices.has(child)) {
					indices.set(child, index);
					low.set(child, index);
					index += 1;
					stack.push(child);
					onStack.add(child);
					work.push({ node: child, next: 0 });
				} else if (onStack.has(child)) {
					low.set(frame.node, Math.min(low.get(frame.node) ?? 0, indices.get(child) ?? 0));
				}
				continue;
			}
			work.pop();
			if (work.length > 0) {
				const parent = work[work.length - 1];
				low.set(parent.node, Math.min(low.get(parent.node) ?? 0, low.get(frame.node) ?? 0));
			}
			if (low.get(frame.node) === indices.get(frame.node)) {
				const component: string[] = [];
				while (stack.length > 0) {
					const n = stack.pop() as string;
					onStack.delete(n);
					component.push(n);
					if (n === frame.node) break;
				}
				result.push(component);
			}
		}
	}
	return result;
}

/** 给模型的紧凑文本，不带噪音。 */
export function formatIssues(result: ValidationResult, limit = 40): string {
	const { stats, issues } = result;
	const head = `实体 ${stats.entities} · 状态 ${stats.states} · 断言 ${stats.assertions}（✔${stats.confirmed} / ⚠${stats.assumed}） · 角色 ${stats.actors} → ${stats.errors} 错误 / ${stats.warnings} 待确认`;
	if (issues.length === 0) return `${head}\n没有发现问题。`;
	const order: Record<Severity, number> = { error: 0, warn: 1 };
	const sorted = [...issues].sort((a, b) => order[a.severity] - order[b.severity]);
	const lines = sorted.slice(0, limit).map((i) => {
		const tag = i.severity === "error" ? "✖" : "⚠";
		return `${tag} [${i.code}] ${i.message}\n    → 问：${i.question}`;
	});
	const more = issues.length > limit ? `\n… 还有 ${issues.length - limit} 条，用 /map 看完整清单。` : "";
	return `${head}\n\n${lines.join("\n")}${more}`;
}
