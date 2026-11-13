/**
 * PR 门禁：三个检查，一个裁决。
 *
 *   validate     IR 自己对不对（零 LLM 图算法）
 *   drift        代码和 IR 是否一致（双向）
 *   conformance  实现是否守住契约（真实实现 × 参考状态机）
 *
 * 设计上最重要的两点：
 *   1. 没有输入就 skip，不假装通过 —— 没给仓库就不要假装 drift 过了。
 *   2. 支持豁免（waiver）和降级（warnOnly）—— 一个第二天就被关掉的门禁等于没有门禁。
 */

import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { IRFile } from "../ir/types.ts";
import { validate } from "../validate/validate.ts";
import { scanAndDrift } from "../scan/drift.ts";
import { runConformance } from "../conformance/harness.ts";

export type CheckId = "validate" | "drift" | "conformance";
export type CheckStatus = "pass" | "fail" | "skip" | "warn";

/** 一条可标注的发现：有 file:line 的才能落到 diff 上 */
export interface GateItem {
	kind: "drift-extra" | "drift-missing" | "validate-error" | "conformance-failure";
	level: "error" | "warning";
	file?: string;
	line?: number;
	title: string;
	message: string;
	/** 稳定标记，用于 PR 评论去重 */
	marker: string;
}

export interface GateCheck {
	id: CheckId;
	title: string;
	status: CheckStatus;
	summary: string;
	details: string[];
	items: GateItem[];
	blocking: boolean;
	waived?: string[];
}

export interface GateReport {
	product: string;
	version: number;
	checks: GateCheck[];
	ok: boolean;
	blocking: number;
	durationMs: number;
}

export interface Waiver {
	from: string;
	action: string;
	to: string;
	reason: string;
}

export interface Waivers {
	/** 已知的、暂时接受的漂移（代码里有、IR 没有） */
	allowDrift?: Waiver[];
	/** 这些检查只警告不拦（比如刚接进来时先观察两周） */
	warnOnly?: CheckId[];
}

export interface GateOptions {
	cwd: string;
	repo?: string;
	adapter?: string;
	filter?: string;
	waivers?: Waivers;
}

const WAIVER_FILE = join(".actormap", "gate.json");

export function loadWaivers(cwd: string): Waivers {
	const path = resolve(cwd, WAIVER_FILE);
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Waivers;
	} catch {
		return {};
	}
}

/** 默认适配器：.actormap/adapter.mjs */
export function defaultAdapter(cwd: string): string | undefined {
	const candidate = resolve(cwd, ".actormap", "adapter.mjs");
	return existsSync(candidate) ? candidate : undefined;
}

/** 从扫描写进 source 的证据串里取回 file:line */
export function parseEvidence(source: string): { file: string; line: number } | undefined {
	const m = source.match(/(?:代码：)?([^\s:][^:]*?):(\d+)\s*$/);
	if (!m) return undefined;
	return { file: m[1].replace(/^代码：/, ""), line: Number(m[2]) };
}

function driftKey(item: { from: string; action: string; to: string }): string {
	return `${item.from}|${item.action}|${item.to}`.toLowerCase();
}

function isWaived(item: { from: string; action: string; to: string }, waivers: Waiver[] | undefined): boolean {
	if (!waivers) return false;
	const key = driftKey(item);
	return waivers.some((w) => driftKey(w) === key);
}

function statusFor(id: CheckId, raw: CheckStatus, waivers: Waivers): CheckStatus {
	return waivers.warnOnly?.includes(id) && raw === "fail" ? "warn" : raw;
}

export async function runGate(ir: IRFile, options: GateOptions): Promise<GateReport> {
	const started = Date.now();
	const waivers = options.waivers ?? {};
	const checks: GateCheck[] = [];

	// ── 1. validate ────────────────────────────────────────────────
	{
		const result = validate(ir);
		const errors = result.issues.filter((i) => i.severity === "error");
		const details = errors.slice(0, 10).map((i) => `${i.code}：${i.message}\n  问：${i.question}`);
		const items: GateItem[] = errors.map((i) => ({
			kind: "validate-error",
			level: "error",
			title: i.code,
			message: `${i.message}\n问：${i.question}`,
			marker: `validate:${i.code}:${i.refs.join(",")}`,
		}));
		const raw: CheckStatus = result.stats.assertions === 0 ? "fail" : errors.length > 0 ? "fail" : "pass";
		checks.push({
			id: "validate",
			title: "需求自洽",
			status: statusFor("validate", raw, waivers),
			summary:
				result.stats.assertions === 0
					? "IR 里没有任何断言"
					: `${result.stats.assertions} 条断言 · ${errors.length} 错误 · ${result.stats.warnings} 待确认`,
			details,
			items,
			blocking: true,
		});
	}

	// ── 2. drift ───────────────────────────────────────────────────
	const repo = options.repo ? resolve(options.cwd, options.repo) : undefined;
	// 扫描结果里的路径是相对仓库根目录的，GitHub 要的是相对 PR 仓库根目录的
	const prefix = repo ? relative(options.cwd, repo).replace(/\\/g, "/") : "";
	if (!repo) {
		checks.push({
			id: "drift",
			title: "实现与需求一致",
			status: "skip",
			summary: "没提供仓库路径，跳过",
			details: ["加 --repo <路径> 才会比对代码"],
			items: [],
			blocking: false,
		});
	} else if (!existsSync(repo)) {
		checks.push({
			id: "drift",
			title: "实现与需求一致",
			status: "fail",
			summary: `仓库路径不存在：${repo}`,
			details: [],
			items: [],
			blocking: true,
		});
	} else {
		const report = scanAndDrift(ir, repo);
		const waived: string[] = [];
		const unwaived = report.onlyInCode.filter((item) => {
			if (!isWaived(item.assertion, waivers.allowDrift)) return true;
			waived.push(driftKey(item.assertion));
			return false;
		});
		const items: GateItem[] = unwaived.map((item) => {
			const a = item.assertion;
			const where = parseEvidence(a.source);
			return {
				kind: "drift-extra",
				level: "error",
				file: where ? (prefix ? `${prefix}/${where.file}` : where.file) : undefined,
				line: where?.line,
				title: `需求里没有这条迁移：${a.from} --${a.action}--> ${a.to}`,
				message: `${item.reason}\n\nIR 里没有确认过这条。要么补进 IR（\`ir_change\`，写清 reason），要么删掉这段代码。`,
				marker: `drift:${a.from}|${a.action}|${a.to}`,
			};
		});
		const details = items.slice(0, 10).map((item) => {
			const head = item.file ? `${item.file}:${item.line ?? "?"}` : item.title;
			return `+ ${item.title}\n  ${item.message.split("\n")[0]}\n  证据：${head}`;
		});
		if (report.onlyInIR.length > 0) {
			details.push(
				`未实现（不拦）：${report.onlyInIR
					.slice(0, 6)
					.map((i) => `${i.assertion.id} ${i.assertion.from}--${i.assertion.action}-->${i.assertion.to}`)
					.join("、")}${report.onlyInIR.length > 6 ? ` 等 ${report.onlyInIR.length} 条` : ""}`,
			);
		}
		const raw: CheckStatus = unwaived.length > 0 ? "fail" : "pass";
		checks.push({
			id: "drift",
			title: "实现与需求一致",
			status: statusFor("drift", raw, waivers),
			summary:
				`对上 ${report.matched} 条 · 代码多出 ${unwaived.length} 条` +
				(waived.length > 0 ? `（已豁免 ${waived.length}）` : "") +
				` · 未实现 ${report.onlyInIR.length} 条`,
			details,
			items,
			blocking: raw === "fail",
			waived,
		});
	}

	// ── 3. conformance ─────────────────────────────────────────────
	const adapter = options.adapter ? resolve(options.cwd, options.adapter) : defaultAdapter(options.cwd);
	if (!adapter) {
		checks.push({
			id: "conformance",
			title: "契约测试",
			status: "skip",
			summary: "没提供适配器，跳过",
			details: ["加 --adapter <路径>，或把适配器放到 .actormap/adapter.mjs"],
			items: [],
			blocking: false,
		});
	} else if (!existsSync(adapter)) {
		checks.push({
			id: "conformance",
			title: "契约测试",
			status: "fail",
			summary: `适配器不存在：${adapter}`,
			details: [],
			items: [],
			blocking: true,
		});
	} else {
		try {
			const report = await runConformance(ir, adapter, { filter: options.filter });
			const failures = report.results.filter((r) => r.outcome === "fail");
			const details = failures.slice(0, 10).map((f) => {
				const c = f.case;
				const input = Object.entries(c.ctx).map(([k, v]) => `${k}=${v}`).join(", ");
				return `✖ ${c.assertionId} ${c.kind}：${c.from} --${c.action}--> ${c.to}（${c.by}）\n  ${f.detail ?? ""}${input ? `\n  输入：${input}` : ""}`;
			});
			const items: GateItem[] = failures.map((f) => {
				const c = f.case;
				const input = Object.entries(c.ctx).map(([k, v]) => `${k}=${v}`).join(", ");
				return {
					kind: "conformance-failure",
					level: "error",
					title: `契约破了：${c.assertionId}（${c.kind}）`,
					message: `${c.from} --${c.action}--> ${c.to}（${c.by}）\n${f.detail ?? "不一致"}${input ? `\n输入：${input}` : ""}`,
					marker: `conformance:${c.id}`,
				};
			});
			if (report.unchecked.length > 0) {
				details.push(`机器没判的条件（需人看）：${report.unchecked.map((u) => u.assertionId).join("、")}`);
			}
			const raw: CheckStatus = failures.length > 0 ? "fail" : "pass";
			checks.push({
				id: "conformance",
				title: "契约测试",
				status: statusFor("conformance", raw, waivers),
				summary: `${report.passed}/${report.passed + report.failed + report.skipped} 通过` +
					(failures.length > 0 ? ` · ${failures.length} 失败` : "") +
					(report.skipped > 0 ? ` · ${report.skipped} 无法执行` : ""),
				details,
				items,
				blocking: raw === "fail",
			});
		} catch (error) {
			checks.push({
				id: "conformance",
				title: "契约测试",
				status: statusFor("conformance", "fail", waivers),
				summary: `适配器跑不起来：${(error as Error).message}`,
				details: [],
				items: [],
				blocking: true,
			});
		}
	}

	// 只有 fail 拦人；warn 是被人主动降级的，不拦
	const blocking = checks.filter((c) => c.status === "fail").length;
	return {
		product: ir.product,
		version: ir.version,
		checks,
		ok: blocking === 0,
		blocking,
		durationMs: Date.now() - started,
	};
}

const TAGS: Record<CheckStatus, string> = { pass: "✔", fail: "✖", warn: "⚠", skip: "–" };

export function formatGate(report: GateReport, verbose = true): string {
	const lines: string[] = [];
	const head = report.ok
		? `门禁通过 · ${report.product} v${report.version}`
		: `门禁未通过 · ${report.product} v${report.version}（${report.blocking} 项拦下）`;
	lines.push(head);
	lines.push("");
	for (const check of report.checks) {
		lines.push(`${TAGS[check.status]} ${check.title}：${check.summary}`);
		if (verbose && check.details.length > 0 && check.status !== "pass") {
			for (const detail of check.details) {
				for (const line of detail.split("\n")) lines.push(`    ${line}`);
			}
		}
	}
	lines.push("");
	lines.push(`${report.durationMs}ms`);
	return lines.join("\n");
}

/** 给 GitHub Actions 的 $GITHUB_STEP_SUMMARY 用 */
export function gateMarkdown(report: GateReport): string {
	const lines: string[] = [];
	lines.push(`## ${report.ok ? "✅ 门禁通过" : "❌ 门禁未通过"} · ${report.product} v${report.version}`);
	lines.push("");
	lines.push("| 检查 | 结果 | 说明 |");
	lines.push("| --- | --- | --- |");
	for (const check of report.checks) {
		const tag = check.status === "pass" ? "✅" : check.status === "fail" ? "❌" : check.status === "warn" ? "⚠️" : "⏭️";
		lines.push(`| ${check.title} | ${tag} | ${check.summary} |`);
	}
	const failing = report.checks.filter((c) => c.status === "fail" || c.status === "warn");
	for (const check of failing) {
		if (check.details.length === 0) continue;
		lines.push("");
		lines.push(`<details><summary>${check.title} · ${check.details.length} 项</summary>`);
		lines.push("");
		for (const detail of check.details) {
			lines.push("```");
			lines.push(detail);
			lines.push("```");
		}
		lines.push("</details>");
	}
	lines.push("");
	return lines.join("\n");
}
