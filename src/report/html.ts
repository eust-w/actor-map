/**
 * 单文件 HTML 地图：不需要任何依赖、不需要服务，双击就能看。
 * 这是给人看的那一面 —— 断言清单给开发，这张图给评审会。
 */

import type { Assertion, IRFile } from "../ir/types.ts";
import { EMPTY_STATE } from "../ir/types.ts";
import type { EntityGraph, ValidationResult } from "../validate/validate.ts";

interface Node {
	state: string;
	level: number;
	row: number;
	x: number;
	y: number;
	terminal: boolean;
	initial: boolean;
}

const COL_W = 220;
const ROW_H = 104;
const NODE_W = 132;
const NODE_H = 44;

function layout(graph: EntityGraph): Map<string, Node> {
	const nodes = new Map<string, Node>();
	const levels = new Map<string, number>();
	const queue: string[] = [];

	for (const entry of graph.initial.length > 0 ? graph.initial : graph.states.slice(0, 1)) {
		levels.set(entry, 0);
		queue.push(entry);
	}
	const order: string[] = [];
	while (queue.length > 0) {
		const state = queue.shift() as string;
		order.push(state);
		const level = levels.get(state) ?? 0;
		for (const edge of graph.out.get(state) ?? []) {
			if (edge.to === EMPTY_STATE) continue;
			if (!levels.has(edge.to)) {
				levels.set(edge.to, level + 1);
				queue.push(edge.to);
			}
		}
	}
	// 回边造成的未访问状态，挂在最后
	for (const state of graph.states) {
		if (!levels.has(state)) levels.set(state, 0);
	}

	const byLevel = new Map<number, string[]>();
	for (const [state, level] of levels) {
		const list = byLevel.get(level) ?? [];
		list.push(state);
		byLevel.set(level, list);
	}
	for (const [level, list] of byLevel) {
		list.sort();
		list.forEach((state, row) => {
			nodes.set(state, {
				state,
				level,
				row,
				x: 48 + level * COL_W,
				y: 40 + row * ROW_H,
				terminal: graph.terminal.includes(state),
				initial: graph.initial.includes(state),
			});
		});
	}
	return nodes;
}

function esc(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function edgePath(from: Node, to: Node): string {
	if (from.state === to.state) {
		const { x, y } = from;
		return `M ${x + NODE_W} ${y + 12} C ${x + NODE_W + 52} ${y - 18}, ${x + NODE_W + 52} ${y + NODE_H + 18}, ${x + NODE_W} ${y + NODE_H - 12}`;
	}
	const x1 = from.x + NODE_W;
	const y1 = from.y + NODE_H / 2;
	const x2 = to.x;
	const y2 = to.y + NODE_H / 2;
	const dx = Math.max(60, Math.abs(x2 - x1) / 2);
	return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

function renderGraph(graph: EntityGraph, assertions: Assertion[]): string {
	const nodes = layout(graph);
	const levels = Math.max(0, ...[...nodes.values()].map((n) => n.level));
	const rows = Math.max(1, ...Object.values(
		[...nodes.values()].reduce<Record<number, number>>((acc, node) => {
			acc[node.level] = (acc[node.level] ?? 0) + 1;
			return acc;
		}, {}),
	));
	const width = 48 * 2 + (levels + 1) * COL_W + NODE_W;
	const height = 40 + rows * ROW_H + 40;

	const parts: string[] = [];
	parts.push(`<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" class="graph">`);
	parts.push(
		`<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="currentColor"/></marker></defs>`,
	);

	for (const a of assertions) {
		if (a.entity !== graph.entity) continue;
		if (a.from === EMPTY_STATE) {
			const to = nodes.get(a.to);
			if (!to) continue;
			parts.push(
				`<path d="M ${to.x - 34} ${to.y + NODE_H / 2} L ${to.x} ${to.y + NODE_H / 2}" class="edge create ${a.status}"/>`,
			);
			continue;
		}
		const from = nodes.get(a.from);
		const to = nodes.get(a.to);
		if (!to) continue;
		if (!from) continue;
		const assumed = a.status === "assumed" ? "assumed" : "confirmed";
		parts.push(`<path d="${edgePath(from, to)}" class="edge ${assumed}" marker-end="url(#arrow)"/>`);
		const mx = (from.x + to.x) / 2 + NODE_W / 2;
		const my = (from.y + to.y) / 2 + NODE_H / 2 - 6;
		parts.push(`<text x="${mx}" y="${my}" class="edge-label">${esc(a.action)}</text>`);
	}

	for (const node of nodes.values()) {
		const kind = node.terminal ? "terminal" : node.initial ? "initial" : "state";
		parts.push(
			`<g class="node ${kind}"><rect x="${node.x}" y="${node.y}" width="${NODE_W}" height="${NODE_H}" rx="10"/><text x="${node.x + NODE_W / 2}" y="${node.y + NODE_H / 2 + 5}">${esc(node.state)}</text></g>`,
		);
	}
	parts.push("</svg>");
	return parts.join("\n");
}

export function renderHTML(ir: IRFile, result: ValidationResult): string {
	const errors = result.issues.filter((i) => i.severity === "error");
	const warns = result.issues.filter((i) => i.severity === "warn");
	const actorRows = ir.actors
		.map((actor) => {
			const count = ir.assertions.filter((a) => a.by === actor.id).length;
			return `<tr><td>${esc(actor.name)}</td><td><code>${esc(actor.id)}</code></td><td>${esc(actor.type)}</td><td>${esc(actor.trigger ?? "—")}</td><td>${count}</td></tr>`;
		})
		.join("\n");

	const graphs = result.graphs
		.map(
			(graph) => `<section class="card">
  <h2>${esc(graph.entity)} <span class="muted">入口 ${esc(graph.initial.join(" / ") || "未定")} · 终态 ${esc(graph.terminal.join(" / ") || "未定")}</span></h2>
  ${renderGraph(graph, ir.assertions)}
</section>`,
		)
		.join("\n");

	const issueList = [...errors, ...warns]
		.map((issue) => {
			const tag = issue.severity === "error" ? "err" : "warn";
			return `<li class="${tag}"><span class="tag">${issue.severity === "error" ? "✖" : "⚠"} ${esc(issue.code)}</span> ${esc(issue.message)}<div class="ask">问：${esc(issue.question)}</div></li>`;
		})
		.join("\n");

	const assertionRows = ir.assertions
		.map((a) => {
			const mark = a.status === "confirmed" ? "✔" : "⚠";
			return `<tr class="${a.status}"><td>${mark} ${esc(a.id)}</td><td><code>${esc(a.by)}</code></td><td>${esc(a.action)}</td><td><code>${esc(a.from)}</code> → <code>${esc(a.to)}</code></td><td>${esc(a.guards.join(" && ") || "—")}</td><td>${esc(a.source || "（无原话）")}</td></tr>`;
		})
		.join("\n");

	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(ir.product)} · 可操作地图</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#111; --muted:#6b7280; --line:#d1d5db; --card:#fafafa; --ok:#0f766e; --warn:#b45309; --err:#b91c1c; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0b0b0c; --fg:#e8e8ea; --muted:#9ca3af; --line:#333; --card:#141416; --ok:#2dd4bf; --warn:#fbbf24; --err:#f87171; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px; background:var(--bg); color:var(--fg); font:14px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif; }
  h1 { font-size:20px; margin:0 0 4px; }
  h2 { font-size:15px; margin:0 0 12px; display:flex; gap:12px; align-items:baseline; flex-wrap:wrap; }
  .muted { color:var(--muted); font-weight:400; font-size:12px; }
  .stats { display:flex; gap:16px; flex-wrap:wrap; margin:12px 0 20px; color:var(--muted); font-size:13px; }
  .stats b { color:var(--fg); }
  .card { border:1px solid var(--line); border-radius:12px; padding:16px; margin-bottom:20px; overflow-x:auto; background:var(--card); }
  .graph { color:var(--muted); display:block; }
  .node rect { fill:var(--bg); stroke:var(--line); stroke-width:1.5; }
  .node text { fill:var(--fg); font-size:13px; text-anchor:middle; }
  .node.initial rect { stroke:var(--ok); stroke-width:2.5; }
  .node.terminal rect { fill:var(--card); stroke-dasharray:5 4; }
  path.edge { fill:none; stroke:var(--muted); stroke-width:1.6; }
  path.edge.assumed { stroke-dasharray:6 5; stroke:var(--warn); }
  path.edge.create { stroke:var(--ok); stroke-width:2.5; }
  .edge-label { fill:var(--muted); font-size:11px; text-anchor:middle; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th,td { text-align:left; padding:6px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:500; }
  tr.assumed td { color:var(--warn); }
  code { font-size:12px; background:rgba(127,127,127,.12); padding:1px 5px; border-radius:4px; }
  ul.issues { list-style:none; padding:0; margin:0; }
  ul.issues li { border-left:3px solid var(--line); padding:8px 0 8px 12px; margin-bottom:10px; }
  ul.issues li.err { border-color:var(--err); }
  ul.issues li.warn { border-color:var(--warn); }
  .tag { font-weight:600; margin-right:6px; }
  .ask { color:var(--muted); font-size:12px; margin-top:4px; }
</style>
</head>
<body>
  <h1>${esc(ir.product)} <span class="muted">v${ir.version} · ${esc(ir.updatedAt)}</span></h1>
  <div class="stats">
    <span><b>${result.stats.assertions}</b> 条断言</span>
    <span>✔ <b>${result.stats.confirmed}</b> 已确认</span>
    <span>⚠ <b>${result.stats.assumed}</b> 待确认</span>
    <span>✖ <b>${result.stats.errors}</b> 错误</span>
    <span>⚠ <b>${result.stats.warnings}</b> 待确认项</span>
    <span><b>${result.stats.actors}</b> 个角色</span>
  </div>

  ${graphs || '<div class="card"><p class="muted">还没有任何断言。</p></div>'}

  <section class="card">
    <h2>缺口 <span class="muted">每条都带着下一句该问的话</span></h2>
    <ul class="issues">${issueList || '<li class="muted">没有发现问题。</li>'}</ul>
  </section>

  <section class="card">
    <h2>角色</h2>
    <table><thead><tr><th>角色</th><th>id</th><th>类型</th><th>触发</th><th>发起动作</th></tr></thead><tbody>${actorRows || '<tr><td colspan="5" class="muted">还没有登记角色</td></tr>'}</tbody></table>
  </section>

  <section class="card">
    <h2>断言清单</h2>
    <table><thead><tr><th>id</th><th>谁</th><th>动作</th><th>状态</th><th>条件</th><th>依据</th></tr></thead><tbody>${assertionRows}</tbody></table>
  </section>
</body>
</html>`;
}
