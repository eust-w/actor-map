/**
 * 漂移检测：代码里实现的迁移 vs IR 里确认的迁移。
 *
 * 两个方向都有价值：
 *   代码有、IR 没有 → 有人偷偷加了需求（或者 IR 漏了）
 *   IR 有、代码没有 → 需求没实现，或者实现了叫别的名字
 *
 * 这是让这个工具从「一次性访谈」变成「长期基础设施」的那一步。
 */

import type { Assertion, IRFile } from "../ir/types.ts";
import { EMPTY_STATE } from "../ir/types.ts";
import type { ScanReport } from "./scanner.ts";
import { scanRepo } from "./scanner.ts";
import type { ScanOptions } from "./scanner.ts";

export interface DriftItem {
	assertion: Assertion;
	reason: string;
}

export interface DriftReport {
	root: string;
	onlyInIR: DriftItem[];
	onlyInCode: DriftItem[];
	matched: number;
}

/** 比较用的键：状态与动作是稳定的，实体名可能一边是 main 一边是 Order */
function key(a: Pick<Assertion, "from" | "action" | "to">): string {
	return `${a.from}|${a.action}|${a.to}`.toLowerCase();
}

function looseKey(a: Pick<Assertion, "action" | "to">): string {
	return `${a.action}|${a.to}`.toLowerCase();
}

export function detectDrift(ir: IRFile, scan: ScanReport): DriftReport {
	const codeAssertions = scan.skeleton.assertions;
	const strict = new Set(codeAssertions.map(key));
	const loose = new Set(codeAssertions.map(looseKey));

	const onlyInIR: DriftItem[] = [];
	let matched = 0;
	for (const a of ir.assertions) {
		if (strict.has(key(a))) {
			matched += 1;
			continue;
		}
		onlyInIR.push({
			assertion: a,
			reason: loose.has(looseKey(a))
				? `代码里有 ${a.action}→${a.to}，但从状态对不上（IR 说从 ${a.from} 出发）`
				: `代码里找不到 ${a.from} --${a.action}--> ${a.to}`,
		});
	}

	const irKeys = new Set(ir.assertions.map(key));
	const irLoose = new Set(ir.assertions.map(looseKey));
	const onlyInCode: DriftItem[] = [];
	for (const a of codeAssertions) {
		if (irKeys.has(key(a))) continue;
		// 创建动作一边写 ∅ 一边写具体状态时，不算漂移
		if (a.from === EMPTY_STATE && ir.assertions.some((x) => x.from === EMPTY_STATE && x.to === a.to)) {
			matched += 1;
			continue;
		}
		onlyInCode.push({
			assertion: a,
			reason: irLoose.has(looseKey(a))
				? `IR 里有 ${a.action}→${a.to}，但起点不同（代码说从 ${a.from} 出发）`
				: `代码里有 ${a.from} --${a.action}--> ${a.to}，IR 里没有确认过`,
		});
	}

	return { root: scan.root, onlyInIR, onlyInCode, matched };
}

export function scanAndDrift(ir: IRFile, root: string, options: ScanOptions = {}): DriftReport {
	return detectDrift(ir, scanRepo(root, options));
}

export function formatDrift(report: DriftReport): string {
	const lines: string[] = [];
	lines.push(`漂移检测 ${report.root}：对上 ${report.matched} 条 · IR 独有 ${report.onlyInIR.length} · 代码独有 ${report.onlyInCode.length}`);
	if (report.onlyInCode.length > 0) {
		lines.push("", "代码里有、IR 没确认（可能是偷偷加的需求）：");
		for (const item of report.onlyInCode.slice(0, 20)) {
			lines.push(`  + ${item.assertion.from} --${item.assertion.action}--> ${item.assertion.to}   ${item.reason}`);
			lines.push(`    证据：${item.assertion.source}`);
		}
	}
	if (report.onlyInIR.length > 0) {
		lines.push("", "IR 确认了、代码里没有（没实现，或者叫别的名字）：");
		for (const item of report.onlyInIR.slice(0, 20)) {
			lines.push(`  - ${item.assertion.id} ${item.assertion.from} --${item.assertion.action}--> ${item.assertion.to}   ${item.reason}`);
		}
	}
	if (report.onlyInCode.length === 0 && report.onlyInIR.length === 0) {
		lines.push("", "实现和需求一致。");
	}
	return lines.join("\n");
}
