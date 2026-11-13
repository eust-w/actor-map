/**
 * 从 IR 导出「能被别人接手的东西」。
 *
 * 三份产物，一个来源：
 *   tools.json    → 给 agent 用（同一张图，不同消费者）
 *   openapi.yaml  → 给后端用
 *   acceptance.md → 给 QA 用
 *
 * 它们不是三份文档，是同一个状态机的三个投影。所以永远不会互相漂移。
 */

import type { Assertion, IRFile } from "../ir/types.ts";
import { EMPTY_STATE } from "../ir/types.ts";
import { parseGuard } from "../validate/guards.ts";

function slug(text: string): string {
	return (
		text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "_")
			.replace(/^_+|_+$/g, "") || "x"
	);
}

function toolName(a: Assertion): string {
	return `${slug(a.entity)}_${slug(a.action)}`;
}

interface JsonSchema {
	type: "object";
	properties: Record<string, { type: string; description?: string }>;
	required: string[];
}

/** 条件里的变量直接变成参数 —— 需求和接口签名是同一件事 */
function schemaFromGuards(assertions: Assertion[]): JsonSchema {
	const properties: Record<string, { type: string; description?: string }> = {
		id: { type: "string", description: "对象 id" },
	};
	for (const a of assertions) {
		for (const guard of a.guards) {
			for (const comparison of parseGuard(guard).numeric) {
				properties[comparison.variable] = {
					type: "number",
					description: `来自条件：${guard}`,
				};
			}
		}
	}
	return { type: "object", properties, required: ["id"] };
}

export function exportTools(ir: IRFile): string {
	const tools = ir.assertions.map((a) => ({
		name: toolName(a),
		description: [
			`${a.by} 在 ${a.from} 状态下执行 ${a.action}，结果是 ${a.to}。`,
			a.guards.length > 0 ? `前置条件：${a.guards.join(" && ")}。` : "",
			a.verify ? `验收：${a.verify}。` : "",
		]
			.filter(Boolean)
			.join(" "),
		assertion: a.id,
		inputSchema: schemaFromGuards([a]),
	}));
	return `${JSON.stringify({ product: ir.product, version: ir.version, tools }, null, 2)}\n`;
}

export function exportOpenAPI(ir: IRFile): string {
	const byPath = new Map<string, Assertion[]>();
	for (const a of ir.assertions) {
		if (a.from === EMPTY_STATE && a.to === EMPTY_STATE) continue;
		const path = `/${slug(a.entity)}s/{id}/${slug(a.action)}`;
		const list = byPath.get(path) ?? [];
		list.push(a);
		byPath.set(path, list);
	}

	const lines: string[] = [];
	lines.push("openapi: 3.0.3");
	lines.push("info:");
	lines.push(`  title: ${yamlString(ir.product)}`);
	lines.push(`  version: "${ir.version}"`);
	lines.push(`  description: ${yamlString("由 ActorMap 从断言清单生成；每个动作 = 一条状态迁移")}`);
	lines.push("paths:");

	for (const [path, list] of [...byPath].sort()) {
		lines.push(`  ${path}:`);
		lines.push("    post:");
		lines.push(`      operationId: ${toolName(list[0])}`);
		lines.push(`      summary: ${yamlString(list.map((a) => `${a.from}→${a.to}（${a.by}）`).join(" / "))}`);
		lines.push("      requestBody:");
		lines.push("        required: true");
		lines.push("        content:");
		lines.push("          application/json:");
		lines.push("            schema:");
		lines.push("              type: object");
		lines.push("              properties:");
		const props = new Map<string, string>();
		for (const a of list) {
			for (const guard of a.guards) {
				for (const comparison of parseGuard(guard).numeric) {
					props.set(comparison.variable, "number");
				}
			}
		}
		if (props.size === 0) {
			lines.push("                {}");
		} else {
			for (const [name, type] of props) lines.push(`                ${yamlKey(name)}: { type: ${type} }`);
		}
		lines.push("      responses:");
		lines.push(`        "200":`);
		lines.push(`          description: ${yamlString(list.map((a) => `状态变为 ${a.to}；${a.verify || "无验收信号"}`).join(" | "))}`);
	}
	return `${lines.join("\n")}\n`;
}

export function exportAcceptance(ir: IRFile): string {
	const lines: string[] = [];
	lines.push(`# ${ir.product} · 验收用例（v${ir.version}）`);
	lines.push("");
	lines.push("由断言清单生成。每条断言 = 一条可执行的验收用例。");
	lines.push("");
	lines.push("| 用例 | 角色 | 前提状态 | 操作 | 条件 | 期望状态 | 验收信号 | 状态 |");
	lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
	for (const a of ir.assertions) {
		const mark = a.status === "confirmed" ? "✔" : "⚠ 待确认";
		lines.push(
			`| ${a.id} | ${a.by} | ${a.from === EMPTY_STATE ? "（对象不存在）" : a.from} | ${a.action} | ${a.guards.join(" && ") || "—"} | ${a.to === EMPTY_STATE ? "（对象消亡）" : a.to} | ${a.verify || "—"} | ${mark} |`,
		);
	}
	lines.push("");
	lines.push("## 反例（每条断言都必须被挡住的输入）");
	lines.push("");
	for (const a of ir.assertions) {
		for (const guard of a.guards) {
			const parsed = parseGuard(guard);
			const parts = parsed.numeric.map((c) => `${c.variable} ${negate(c.op)} ${c.value}`);
			for (const part of parts) {
				lines.push(`- ${a.id} 在 ${part} 时必须被拒绝，且状态不变。`);
			}
		}
	}
	lines.push("");
	return lines.join("\n");
}

function negate(op: string): string {
	const map: Record<string, string> = { "<": ">=", "<=": ">", ">": "<=", ">=": "<", "==": "!=" };
	return map[op] ?? op;
}

function yamlString(text: string): string {
	return JSON.stringify(text);
}

function yamlKey(text: string): string {
	return /^[A-Za-z0-9_-]+$/.test(text) ? text : JSON.stringify(text);
}

export function exportAll(ir: IRFile): Record<string, string> {
	return {
		"tools.json": exportTools(ir),
		"openapi.yaml": exportOpenAPI(ir),
		"acceptance.md": exportAcceptance(ir),
	};
}
