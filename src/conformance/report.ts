/**
 * 契约测试报告：先说结论，再说哪条破了，最后才是细节。
 */

import type { ConformanceReport } from "./harness.ts";

const KIND_LABEL: Record<string, string> = {
	positive: "正例",
	"guard-negative": "反例·条件",
	"actor-negative": "反例·角色",
};

export function formatConformance(report: ConformanceReport, limit = 15): string {
	const lines: string[] = [];
	const total = report.passed + report.failed + report.skipped;
	lines.push(
		`${report.product} v${report.version} × ${report.adapter}：${report.passed}/${total} 通过` +
			(report.failed > 0 ? ` · ${report.failed} 失败` : "") +
			(report.skipped > 0 ? ` · ${report.skipped} 无法执行` : ""),
	);

	const failures = report.results.filter((r) => r.outcome === "fail");
	if (failures.length > 0) {
		lines.push("", "契约破了：");
		for (const item of failures.slice(0, limit)) {
			const c = item.case;
			lines.push(
				`  ✖ ${c.assertionId} ${KIND_LABEL[c.kind] ?? c.kind}：${c.from} --${c.action}--> ${c.to}（${c.by}）`,
			);
			lines.push(`    ${item.detail ?? "不一致"}`);
			if (Object.keys(c.ctx).length > 0) {
				lines.push(`    输入：${Object.entries(c.ctx).map(([k, v]) => `${k}=${v}`).join(", ")}`);
			}
		}
		if (failures.length > limit) lines.push(`  … 还有 ${failures.length - limit} 条`);
	}

	const skips = report.results.filter((r) => r.outcome === "skip");
	if (skips.length > 0) {
		lines.push("", "无法执行（需要人或需要 seed）：");
		for (const item of skips.slice(0, 8)) {
			lines.push(`  ⚠ ${item.case.id}：${item.detail ?? "原因未知"}`);
		}
		if (skips.length > 8) lines.push(`  … 还有 ${skips.length - 8} 条`);
	}

	if (report.unchecked.length > 0) {
		lines.push("", "解析不了的条件（参考状态机不判，人工确认）：");
		for (const item of report.unchecked.slice(0, 8)) {
			lines.push(`  · ${item.assertionId}：${item.reason}`);
		}
	}

	if (failures.length === 0 && skips.length === 0) {
		lines.push("", "实现和需求一致。");
	}
	lines.push("", `耗时 ${report.durationMs}ms`);
	return lines.join("\n");
}

export interface ConformanceSummary {
	total: number;
	passed: number;
	failed: number;
	skipped: number;
	ok: boolean;
}

export function summarize(report: ConformanceReport): ConformanceSummary {
	const total = report.passed + report.failed + report.skipped;
	return {
		total,
		passed: report.passed,
		failed: report.failed,
		skipped: report.skipped,
		ok: report.failed === 0,
	};
}
