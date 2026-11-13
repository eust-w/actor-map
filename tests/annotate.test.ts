import { test } from "node:test";
import assert from "node:assert/strict";
import type { GateReport } from "../src/gate/index.ts";
import {
	additionsByFile,
	buildReviewPayload,
	collectAnnotations,
	parsePatchAdditions,
	parseUnifiedDiff,
	workflowCommands,
} from "../src/gate/annotate.ts";

function report(overrides: Partial<GateReport> = {}): GateReport {
	const base: GateReport = {
		product: "报销",
		version: 3,
		ok: false,
		blocking: 1,
		durationMs: 5,
		checks: [
			{
				id: "validate",
				title: "需求自洽",
				status: "pass",
				summary: "8 条断言 · 0 错误",
				details: [],
				items: [],
				blocking: true,
			},
			{
				id: "drift",
				title: "实现与需求一致",
				status: "fail",
				summary: "代码多出 1 条",
				details: [],
				items: [
					{
						kind: "drift-extra",
						level: "error",
						file: "src/order.ts",
						line: 12,
						title: "需求里没有这条迁移：submitted --cancel--> cancelled",
						message: "IR 里没有确认过",
						marker: "drift:submitted|cancel|cancelled",
					},
					{
						kind: "drift-extra",
						level: "error",
						file: "src/old.ts",
						line: 99,
						title: "需求里没有这条迁移：draft --archive--> archived",
						message: "IR 里没有确认过",
						marker: "drift:draft|archive|archived",
					},
				],
				blocking: true,
			},
			{
				id: "conformance",
				title: "契约测试",
				status: "fail",
				summary: "3 失败",
				details: [],
				items: [
					{
						kind: "conformance-failure",
						level: "error",
						title: "契约破了：a_003",
						message: "期望被拒绝",
						marker: "conformance:a_003-neg1",
					},
				],
				blocking: true,
			},
		],
	};
	return { ...base, ...overrides };
}

test("只标新增行，不标上下文和删除行", () => {
	const patch = "@@ -1,3 +10,5 @@\n a\n-b\n+c\n+d\n e";
	assert.deepEqual([...parsePatchAdditions(patch)].sort((x, y) => x - y), [11, 12]);
});

test("多个 hunk 时行号各自接续", () => {
	const patch = ["@@ -1,2 +1,3 @@", " a", "+b", " c", "@@ -20,2 +25,3 @@", " x", "+y", " z"].join("\n");
	assert.deepEqual([...parsePatchAdditions(patch)].sort((x, y) => x - y), [2, 26]);
});

test("从 unified diff 里按文件取新增行", () => {
	const diff = [
		"diff --git a/src/a.ts b/src/a.ts",
		"--- a/src/a.ts",
		"+++ b/src/a.ts",
		"@@ -1,1 +1,2 @@",
		" keep",
		"+added",
		"diff --git a/src/b.ts b/src/b.ts",
		"--- a/src/b.ts",
		"+++ b/src/b.ts",
		"@@ -5,1 +5,2 @@",
		" ctx",
		"+new",
	].join("\n");
	const map = parseUnifiedDiff(diff);
	assert.deepEqual([...(map.get("src/a.ts") ?? [])], [2]);
	assert.deepEqual([...(map.get("src/b.ts") ?? [])], [6]);
});

test("落在 diff 里的贴行内，落在之外的降级进正文", () => {
	const payload = buildReviewPayload(
		report(),
		collectAnnotations(report()),
		new Map([["src/order.ts", new Set([12])]]),
	);
	assert.equal(payload.comments.length, 1);
	assert.equal(payload.comments[0].line, 12);
	assert.equal(payload.comments[0].side, "RIGHT");
	assert.match(payload.comments[0].body, /actormap:drift:submitted\|cancel\|cancelled/);
	assert.equal(payload.skipped.length, 2, "旧文件 + 契约测试失败都进正文");
	const reasons = payload.skipped.map((s) => s.reason).join("\n");
	assert.match(reasons, /不在本次新增里|不在本次改动里|没有代码位置/);
});

test("没有 diff 信息时全部降级，不丢发现", () => {
	const payload = buildReviewPayload(report(), collectAnnotations(report()), null);
	assert.equal(payload.comments.length, 0);
	assert.equal(payload.skipped.length, 3);
	assert.match(payload.body, /落在 diff 之外/);
	assert.match(payload.body, /src\/old\.ts:99/);
});

test("正文带结论表格和修复指引", () => {
	const payload = buildReviewPayload(report(), [], null);
	assert.match(payload.body, /门禁未通过/);
	assert.match(payload.body, /\| 需求自洽 \| ✅ \|/);
	assert.match(payload.body, /<\.actormap\/gate\.json>|gate\.json/);
});

test("工作流命令按 GitHub 规则转义", () => {
	const [line] = workflowCommands([
		{ level: "error", file: "a,b.ts", line: 3, title: "t:x", message: "50%\nline2", marker: "m" },
	]);
	assert.ok(line.startsWith("::error "));
	assert.match(line, /file=a%2Cb\.ts/);
	assert.match(line, /title=t%3Ax/);
	assert.ok(line.endsWith("::50%25%0Aline2"));
});

test("additionsByFile 兼容 PR files API 的形状", () => {
	const map = additionsByFile([{ filename: "x.ts", patch: "@@ -0,0 +1,2 @@\n+a\n+b" }]);
	assert.deepEqual([...(map.get("x.ts") ?? [])], [1, 2]);
});

test("路径前缀对不上时用后缀匹配兜底", () => {
	const payload = buildReviewPayload(
		report(),
		collectAnnotations(report()),
		new Map([["examples/app/src/order.ts", new Set([12])]]),
	);
	assert.equal(payload.comments.length, 1);
	assert.equal(payload.comments[0].path, "examples/app/src/order.ts");
});
