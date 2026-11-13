/**
 * 断言清单：唯一需要"人签字"的产物。
 * ✔ 可以照着写代码，⚠ 还得回去问人。
 */

import type { IRFile } from "../ir/types.ts";
import type { ValidationResult } from "../validate/validate.ts";

const ACTOR_LABEL: Record<string, string> = {
	human: "人",
	anonymous: "匿名访客",
	system: "系统",
	external: "外部",
	virtual: "代理",
	batch: "批量",
};

export function renderChecklist(ir: IRFile, result: ValidationResult): string {
	const { stats, issues, graphs } = result;
	const lines: string[] = [];

	lines.push(`# ${ir.product} · 断言清单 v${ir.version}`);
	lines.push("");
	lines.push(`> ${ir.assertions.length} 条断言 · ✔ ${stats.confirmed} 已确认 · ⚠ ${stats.assumed} 待确认 · ${stats.errors} 错误 · ${stats.warnings} 待确认项`);
	lines.push("");
	lines.push(`更新于 ${ir.updatedAt}`);
	lines.push("");

	// 角色
	lines.push("## 角色");
	lines.push("");
	lines.push("| 角色 | id | 类型 | 触发 | 发起动作数 |");
	lines.push("| --- | --- | --- | --- | --- |");
	for (const actor of ir.actors) {
		const count = ir.assertions.filter((a) => a.by === actor.id).length;
		const trigger = actor.trigger ? actor.trigger : actor.type === "human" || actor.type === "anonymous" ? "—" : "**未填**";
		lines.push(`| ${actor.name} | \`${actor.id}\` | ${ACTOR_LABEL[actor.type] ?? actor.type} | ${trigger} | ${count} |`);
	}
	if (ir.actors.length === 0) lines.push("| — | — | — | — | — |");
	lines.push("");

	// 断言
	for (const graph of graphs) {
		lines.push(`## 流程：${graph.entity}`);
		lines.push("");
		if (graph.initial.length > 0) {
			lines.push(`入口：${graph.initial.map((s) => `\`${s}\``).join(" / ")} · 终态：${graph.terminal.map((s) => `\`${s}\``).join(" / ") || "（未定）"}`);
			lines.push("");
		}
		const edges = ir.assertions.filter((a) => a.entity === graph.entity);
		for (const a of edges) {
			const mark = a.status === "confirmed" ? "✔" : "⚠";
			lines.push(`- ${mark} **${a.id}** \`${a.by}\` · **${a.action}**：\`${a.from}\` → \`${a.to}\``);
			if (a.guards.length > 0) lines.push(`  - 条件：${a.guards.join(" && ")}`);
			if (a.verify) lines.push(`  - 验收：${a.verify}`);
			lines.push(`  - 依据：${a.source ? `「${a.source}」` : "**（无原话，待确认）**"}`);
		}
		lines.push("");
	}

	// 缺口
	lines.push("## 缺口");
	lines.push("");
	if (issues.length === 0) {
		lines.push("没有发现问题。");
	} else {
		for (const issue of issues) {
			const tag = issue.severity === "error" ? "✖ 错误" : "⚠ 待确认";
			lines.push(`- **${tag}** \`${issue.code}\` — ${issue.message}`);
			lines.push(`  - 追问：${issue.question}`);
		}
	}
	lines.push("");

	const assumed = ir.assertions.filter((a) => a.status === "assumed");
	if (assumed.length > 0) {
		lines.push("## 需要回头确认的假设");
		lines.push("");
		for (const a of assumed) lines.push(`- ${a.id}：${a.from} --${a.action}--> ${a.to}（${a.by}）`);
		lines.push("");
	}

	return lines.join("\n");
}
