/**
 * 把门禁发现变成「能贴在 diff 某一行上的东西」。
 *
 * 两个通道，都实现，因为它们的成本完全不同：
 *   Workflow commands（::error file=…,line=…） —— 零权限，Actions 里自动出现在 diff 上
 *   PR review comments                        —— 需要 token，但能带解释和讨论
 *
 * 关键约束：GitHub 只接受落在 diff 里的行。所以所有标注都要先过一遍 changed-lines。
 * 落不进去的不丢，降级写进 review 正文。
 */

import type { GateReport, GateItem } from "./index.ts";

export interface Annotation {
	level: "error" | "warning" | "notice";
	file?: string;
	line?: number;
	title: string;
	message: string;
	marker: string;
}

export interface ReviewComment {
	path: string;
	line: number;
	side: "RIGHT";
	body: string;
}

export interface SkippedAnnotation {
	annotation: Annotation;
	reason: string;
}

export interface ReviewPayload {
	body: string;
	comments: ReviewComment[];
	skipped: SkippedAnnotation[];
}

export function collectAnnotations(report: GateReport): Annotation[] {
	const annotations: Annotation[] = [];
	for (const check of report.checks) {
		for (const item of check.items) {
			annotations.push({
				level: item.level,
				file: item.file,
				line: item.line,
				title: `[${check.title}] ${item.title}`,
				message: item.message,
				marker: item.marker,
			});
		}
	}
	return annotations;
}

// ── GitHub Actions 工作流命令 ────────────────────────────────────────────

function escapeData(value: string): string {
	return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function escapeProperty(value: string): string {
	return escapeData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

export function workflowCommands(annotations: Annotation[]): string[] {
	return annotations.map((a) => {
		const props: string[] = [];
		if (a.file) props.push(`file=${escapeProperty(a.file)}`);
		if (a.file && typeof a.line === "number") props.push(`line=${a.line}`);
		props.push(`title=${escapeProperty(a.title)}`);
		const level = a.level === "error" ? "error" : "warning";
		return `::${level} ${props.join(",")}::${escapeData(a.message)}`;
	});
}

// ── diff 行号 ────────────────────────────────────────────────────────────

/**
 * 从 GitHub PR files API 的 patch 里取出「新增行」的新文件行号。
 * 只标新增行：注释在别人的上下文行上会让 review 变得很吵。
 */
export function parsePatchAdditions(patch: string | undefined): Set<number> {
	const added = new Set<number>();
	if (!patch) return added;
	let newLine = 0;
	for (const raw of patch.split("\n")) {
		const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
		if (hunk) {
			newLine = Number(hunk[1]);
			continue;
		}
		if (raw.startsWith("+")) {
			added.add(newLine);
			newLine += 1;
			continue;
		}
		if (raw.startsWith("-")) continue;
		if (raw.startsWith("\\")) continue;
		newLine += 1;
	}
	return added;
}

export interface PrFile {
	filename: string;
	patch?: string;
	status?: string;
}

/**
 * 本地跑的时候用：从一个 unified diff 里取出「每个文件新增了哪些行」。
 * 这样 --dry-run 不需要网络，也能预览会贴在哪几行。
 */
export function parseUnifiedDiff(text: string): Map<string, Set<number>> {
	const map = new Map<string, Set<number>>();
	let current: string | undefined;
	let newLine = 0;
	for (const raw of text.split("\n")) {
		if (raw.startsWith("+++ ")) {
			const path = raw.slice(4).trim().replace(/^b\//, "");
			current = path === "/dev/null" ? undefined : path;
			if (current) map.set(current, map.get(current) ?? new Set<number>());
			continue;
		}
		if (raw.startsWith("diff --git")) {
			current = undefined;
			continue;
		}
		const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
		if (hunk) {
			newLine = Number(hunk[1]);
			continue;
		}
		if (!current) continue;
		if (raw.startsWith("+")) {
			map.get(current)?.add(newLine);
			newLine += 1;
		} else if (raw.startsWith("-") || raw.startsWith("\\")) {
			continue;
		} else {
			newLine += 1;
		}
	}
	return map;
}

export function additionsByFile(files: PrFile[]): Map<string, Set<number>> {
	const map = new Map<string, Set<number>>();
	for (const file of files) {
		map.set(file.filename, parsePatchAdditions(file.patch));
	}
	return map;
}

// ── Review 载荷 ─────────────────────────────────────────────────────────

function commentBody(annotation: Annotation): string {
	return [
		`**${annotation.title}**`,
		"",
		annotation.message,
		"",
		`<!-- actormap:${annotation.marker} -->`,
	].join("\n");
}

function table(report: GateReport): string {
	const tag = (status: string) =>
		status === "pass" ? "✅" : status === "fail" ? "❌" : status === "warn" ? "⚠️" : "⏭️";
	const lines = ["| 检查 | 结果 | 说明 |", "| --- | --- | --- |"];
	for (const check of report.checks) {
		lines.push(`| ${check.title} | ${tag(check.status)} | ${check.summary} |`);
	}
	return lines.join("\n");
}

export const VERDICT_MARKER = "<!-- actormap:verdict -->";

function resolvePath(file: string, additions: Map<string, Set<number>>): string | undefined {
	if (additions.has(file)) return file;
	const suffix = `/${file.replace(/^\.\//, "")}`;
	for (const key of additions.keys()) {
		if (key.endsWith(suffix)) return key;
	}
	return undefined;
}

export function buildReviewPayload(
	report: GateReport,
	annotations: Annotation[],
	additions: Map<string, Set<number>> | null,
): ReviewPayload {
	const comments: ReviewComment[] = [];
	const skipped: SkippedAnnotation[] = [];

	for (const annotation of annotations) {
		if (!annotation.file) {
			skipped.push({ annotation, reason: "没有代码位置" });
			continue;
		}
		if (!additions) {
			skipped.push({ annotation, reason: "没有 PR diff 信息" });
			continue;
		}
		// 扫描结果里的路径可能相对仓库根，diff 里的路径相对 PR 根，做一次后缀匹配兜底
		const match = resolvePath(annotation.file, additions);
		const lines = match ? additions.get(match) : undefined;
		if (!match || !lines) {
			skipped.push({ annotation, reason: "这个文件不在本次改动里" });
			continue;
		}
		if (typeof annotation.line !== "number" || !lines.has(annotation.line)) {
			skipped.push({ annotation, reason: `第 ${annotation.line ?? "?"} 行不在本次新增里` });
			continue;
		}
		comments.push({
			path: match,
			line: annotation.line,
			side: "RIGHT",
			body: commentBody(annotation),
		});
	}

	const head = report.ok
		? `### ✅ ActorMap 门禁通过 · ${report.product} v${report.version}`
		: `### ❌ ActorMap 门禁未通过 · ${report.product} v${report.version}`;
	const parts = [VERDICT_MARKER, head, "", table(report)];

	if (comments.length > 0) {
		parts.push("", `已在 diff 上留了 **${comments.length}** 条行内备注。`);
	}
	if (skipped.length > 0) {
		parts.push("", "<details><summary>落在 diff 之外的发现（" + skipped.length + " 条）</summary>", "");
		for (const item of skipped) {
			const where = item.annotation.file
				? `\`${item.annotation.file}:${item.annotation.line ?? "?"}\``
				: "—";
			parts.push(`- **${item.annotation.title}** ${where} — ${item.reason}`, "", item.annotation.message.replace(/\n/g, " "));
		}
		parts.push("", "</details>");
	}
	if (!report.ok) {
		parts.push("", "> 修完之后重跑 `actormap gate`。要让门禁放行已知问题，改 `.actormap/gate.json` 并写清 reason。");
	}

	return { body: parts.join("\n"), comments, skipped };
}

export type { GateItem };
