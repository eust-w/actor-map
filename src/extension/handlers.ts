/**
 * 工具的实际逻辑，和 pi 解耦。
 *
 * index.ts 只负责声明 schema 并转发到这里 —— 这样访谈逻辑能被普通单元测试覆盖，
 * 不需要跑模型、也不需要装 pi。
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Actor, Change, IRFile } from "../ir/types.ts";
import { acknowledgeTerminals, addActor, addAssertion, bumpVersion, loadIR, resolveIRPath, saveIR } from "../ir/store.ts";
import { applyChangeSet, formatImpact } from "../ir/changes.ts";
import { formatIssues, validate } from "../validate/validate.ts";
import { renderChecklist } from "../report/checklist.ts";
import { renderHTML } from "../report/html.ts";
import { formatScanReport, scanRepo } from "../scan/scanner.ts";
import { exportAll } from "../export/index.ts";
import { formatDrift, scanAndDrift } from "../scan/drift.ts";
import { runConformance } from "../conformance/harness.ts";
import { formatConformance, summarize } from "../conformance/report.ts";

export interface HandlerResult {
	text: string;
	details: Record<string, unknown>;
}

export interface AddActorParams {
	id: string;
	name: string;
	type: Actor["type"];
	trigger?: string;
	note?: string;
}

export interface AddAssertionParams {
	entity?: string;
	from: string;
	action: string;
	to: string;
	by: string;
	guards?: string[];
	verify?: string;
	source?: string;
	status?: "confirmed" | "assumed";
}

export interface ChangeParams {
	reason: string;
	changes: Change[];
}

export interface ValidateParams {
	acknowledge_terminal?: string[];
}

export interface ScanParams {
	path?: string;
	seed?: boolean;
	force?: boolean;
}

export function writeArtifacts(cwd: string, ir: IRFile): { md: string; html: string } {
	const result = validate(ir);
	mkdirSync(join(cwd, ".actormap"), { recursive: true });
	const md = join(cwd, ".actormap", "map.md");
	const html = join(cwd, ".actormap", "map.html");
	writeFileSync(md, renderChecklist(ir, result), "utf8");
	writeFileSync(html, renderHTML(ir, result), "utf8");
	return { md, html };
}

function load(cwd: string, product?: string) {
	const path = resolveIRPath(cwd);
	return { path, ir: loadIR(path, product) };
}

export function addActorTool(params: AddActorParams, cwd: string): HandlerResult {
	const { path, ir } = load(cwd);
	const actor = addActor(ir, params);
	saveIR(path, ir);
	writeArtifacts(cwd, ir);
	return {
		text: `已登记角色 ${actor.name}(${actor.id}) · ${actor.type}。当前共 ${ir.actors.length} 个角色。`,
		details: { actor, actors: ir.actors.length, irPath: path },
	};
}

export function addAssertionTool(params: AddAssertionParams, cwd: string): HandlerResult {
	const { path, ir } = load(cwd);
	const outcome = addAssertion(ir, params);
	if (!outcome.ok) throw new Error(outcome.error);
	bumpVersion(ir);
	saveIR(path, ir);
	const { md } = writeArtifacts(cwd, ir);
	const result = validate(ir);
	const a = outcome.assertion;
	const lines = [
		`已记录 ${a.id}：${a.by} ${a.from} --${a.action}--> ${a.to}`,
		...outcome.warnings.map((w) => `⚠ ${w}`),
		`当前 ${result.stats.assertions} 条断言 · ${result.stats.errors} 错误 · ${result.stats.warnings} 待确认（清单：${md}）`,
	];
	return { text: lines.join("\n"), details: { assertion: a, warnings: outcome.warnings, stats: result.stats } };
}

export function changeTool(params: ChangeParams, cwd: string): HandlerResult {
	const { path, ir } = load(cwd);
	const outcome = applyChangeSet(ir, params.reason, params.changes);
	if (!outcome.ok) throw new Error(outcome.error);
	saveIR(path, ir);
	const { md } = writeArtifacts(cwd, ir);
	const result = validate(ir);
	return {
		text: `${formatImpact(outcome.changeSet, outcome.impact)}\n\n清单已更新：${md}（${result.stats.assertions} 条断言）`,
		details: { changeSet: outcome.changeSet, impact: outcome.impact, stats: result.stats },
	};
}

export function validateTool(params: ValidateParams, cwd: string): HandlerResult {
	const { path, ir } = load(cwd);
	const acknowledged = acknowledgeTerminals(ir, params.acknowledge_terminal ?? []);
	if (acknowledged.length > 0) saveIR(path, ir);
	const result = validate(ir);
	const clean = result.stats.errors === 0 && result.stats.assertions > 0;
	if (clean && ir.version > 0) bumpVersion(ir);
	if (clean || acknowledged.length > 0) saveIR(path, ir);
	const { md } = writeArtifacts(cwd, ir);
	return {
		text: `${formatIssues(result)}\n\n清单：${md}${clean ? `\n\n这一版自洽，可以定稿 v${ir.version}。` : ""}`,
		details: { stats: result.stats, issues: result.issues, acknowledged, mapPath: md },
	};
}

export function scanTool(params: ScanParams, cwd: string): HandlerResult {
	const { path: irPath } = load(cwd);
	const repo = resolve(cwd, params.path ?? ".");
	const report = scanRepo(repo);
	mkdirSync(join(cwd, ".actormap"), { recursive: true });
	const reportPath = join(cwd, ".actormap", "scan-report.json");
	writeFileSync(
		reportPath,
		`${JSON.stringify({ root: report.root, filesScanned: report.filesScanned, findings: report.findings, questions: report.questions, warnings: report.warnings, skeleton: report.skeleton }, null, 2)}\n`,
		"utf8",
	);

	if (params.seed && existsSync(irPath) && !params.force) {
		return {
			text: `${formatScanReport(report)}\n\n⚠ ${irPath} 已存在，未覆盖。确认要覆盖就带 force=true。`,
			details: { report, seeded: false, reportPath },
		};
	}

	let seeded = false;
	if (params.seed) {
		saveIR(irPath, report.skeleton);
		seeded = true;
	}
	const tail = seeded
		? `\n\n骨架已写入 ${irPath}。接下来逐个追问下面这些问题，然后调用 ir_validate。`
		: `\n\n明细：${reportPath}`;
	return { text: `${formatScanReport(report)}${tail}`, details: { report, seeded, reportPath } };
}

export function mapSummary(cwd: string, product?: string): string {
	const { path, ir } = load(cwd, product);
	const result = validate(ir);
	const { md, html } = writeArtifacts(cwd, ir);
	return [
		`${ir.product} v${ir.version} · 断言 ${result.stats.assertions}（✔${result.stats.confirmed}/⚠${result.stats.assumed}） · ${result.stats.errors} 错误 / ${result.stats.warnings} 待确认`,
		`清单：${md}`,
		`地图：${html}`,
		`IR：${path}`,
	].join("\n");
}

export interface ExportParams {
	dir?: string;
}

export function exportTool(params: ExportParams, cwd: string): HandlerResult {
	const { ir } = load(cwd);
	const outDir = resolve(cwd, params.dir ?? ".actormap/export");
	mkdirSync(outDir, { recursive: true });
	const files = exportAll(ir);
	const written: string[] = [];
	for (const [name, content] of Object.entries(files)) {
		const target = join(outDir, name);
		writeFileSync(target, content, "utf8");
		written.push(target);
	}
	return {
		text: `已导出（同一个状态机的多个投影）：\n${written.map((p) => `  · ${p}`).join("\n")}`,
		details: { written },
	};
}

export interface DriftParams {
	path?: string;
}

export function driftTool(params: DriftParams, cwd: string): HandlerResult {
	const { ir } = load(cwd);
	const repo = resolve(cwd, params.path ?? ".");
	const report = scanAndDrift(ir, repo);
	return {
		text: formatDrift(report),
		details: {
			matched: report.matched,
			onlyInCode: report.onlyInCode.map((d) => ({ assertion: d.assertion, reason: d.reason })),
			onlyInIR: report.onlyInIR.map((d) => ({ assertion: d.assertion, reason: d.reason })),
		},
	};
}

export interface ConformanceParams {
	adapter: string;
	filter?: string;
}

export async function conformanceTool(params: ConformanceParams, cwd: string): HandlerResult {
	const { ir } = load(cwd);
	const report = await runConformance(ir, resolve(cwd, params.adapter), { filter: params.filter });
	const summary = summarize(report);
	return {
		text: formatConformance(report),
		details: {
			ok: summary.ok,
			passed: summary.passed,
			failed: summary.failed,
			skipped: summary.skipped,
			results: report.results.map((r) => ({
				id: r.case.id,
				kind: r.case.kind,
				outcome: r.outcome,
				detail: r.detail,
			})),
		},
	};
}
