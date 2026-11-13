#!/usr/bin/env node
/**
 * 不依赖 pi 的命令行入口：校验、出清单、出地图、扫仓库、改需求。
 * 用途：CI 门禁、评审会上放一张图、把仓库反抽成骨架。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Change } from "./ir/types.ts";
import { emptyIR } from "./ir/types.ts";
import { loadIR, resolveIRPath, saveIR } from "./ir/store.ts";
import { applyChangeSet, formatImpact } from "./ir/changes.ts";
import { formatIssues, validate } from "./validate/validate.ts";
import { renderChecklist } from "./report/checklist.ts";
import { renderHTML } from "./report/html.ts";
import { exportAll } from "./export/index.ts";
import { formatScanReport, scanRepo } from "./scan/scanner.ts";
import { formatDrift, scanAndDrift } from "./scan/drift.ts";

const argv = process.argv.slice(2);
const command = argv[0] ?? "report";
const flag = (name: string): string | undefined => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string): boolean => argv.includes(`--${name}`);

const product = flag("product") ?? "未命名产品";
const irPath = resolveIRPath(process.cwd(), flag("ir"));
const positional = argv.slice(1).filter((a) => !a.startsWith("--") && a !== flag("ir") && a !== flag("out"));

function writeOut(path: string, content: string): string {
	const target = resolve(process.cwd(), path);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, content, "utf8");
	return target;
}

function loadOrExit() {
	if (!existsSync(irPath)) {
		console.error(`找不到 ${irPath}。先跑 \`actormap init\`，或 \`actormap scan --seed\` 从代码起一张。`);
		process.exit(2);
	}
	return loadIR(irPath, product);
}

switch (command) {
	case "init": {
		if (existsSync(irPath)) {
			console.error(`已存在：${irPath}，未覆盖。`);
			process.exit(1);
		}
		const ir = emptyIR(positional[0] ?? product);
		mkdirSync(dirname(irPath), { recursive: true });
		saveIR(irPath, ir);
		console.log(`已创建 ${irPath}`);
		break;
	}

	case "validate": {
		const ir = loadOrExit();
		const result = validate(ir);
		console.log(formatIssues(result, 200));
		process.exitCode = result.stats.errors > 0 ? 1 : 0;
		break;
	}

	case "report": {
		const ir = loadOrExit();
		const result = validate(ir);
		const markdown = renderChecklist(ir, result);
		const out = flag("out");
		if (out) {
			const target = writeOut(out, markdown);
			console.log(`写入 ${target}（${result.stats.errors} 错误 / ${result.stats.warnings} 待确认）`);
		} else {
			console.log(markdown);
		}
		process.exitCode = result.stats.errors > 0 ? 1 : 0;
		break;
	}

	case "render": {
		const ir = loadOrExit();
		const result = validate(ir);
		const target = writeOut(flag("out") ?? ".actormap/map.html", renderHTML(ir, result));
		console.log(`地图：${target}（${result.stats.assertions} 条断言 · ${result.stats.errors} 错误 / ${result.stats.warnings} 待确认）`);
		break;
	}

	case "scan": {
		const repo = resolve(process.cwd(), flag("repo") ?? positional[0] ?? ".");
		const report = scanRepo(repo);
		console.log(formatScanReport(report));
		const out = flag("out") ?? joinSafe(".actormap", "scan-report.json");
		const target = writeOut(
			out,
			`${JSON.stringify({ root: report.root, filesScanned: report.filesScanned, findings: report.findings, questions: report.questions, warnings: report.warnings }, null, 2)}\n`,
		);
		console.log(`扫描明细：${target}`);
		if (has("seed")) {
			if (existsSync(irPath) && !has("force")) {
				console.error(`\n${irPath} 已存在，加了 --force 才会覆盖。`);
				process.exitCode = 1;
				break;
			}
			saveIR(irPath, report.skeleton);
			console.log(`骨架已写入 ${irPath}（${report.skeleton.assertions.length} 条迁移）。下一步：actormap validate`);
		}
		break;
	}

	case "change": {
		const ir = loadOrExit();
		const reason = flag("reason");
		const file = flag("file");
		if (!reason || !file) {
			console.error("用法：actormap change --reason \"为什么改\" --file changes.json");
			process.exit(2);
		}
		const changes = JSON.parse(readFileSync(resolve(process.cwd(), file), "utf8")) as Change[];
		const outcome = applyChangeSet(ir, reason, changes);
		if (!outcome.ok) {
			console.error(outcome.error);
			process.exit(1);
		}
		saveIR(irPath, ir);
		console.log(formatImpact(outcome.changeSet, outcome.impact));
		const result = validate(ir);
		const target = writeOut(".actormap/map.md", renderChecklist(ir, result));
		writeOut(".actormap/map.html", renderHTML(ir, result));
		console.log(`清单已更新：${target}`);
		process.exitCode = result.stats.errors > 0 ? 1 : 0;
		break;
	}

	case "export": {
		const ir = loadOrExit();
		const outDir = flag("out") ?? ".actormap";
		const files = exportAll(ir);
		const written: string[] = [];
		for (const [name, content] of Object.entries(files)) {
			written.push(writeOut(joinSafe(outDir, name), content));
		}
		console.log(`已导出 ${written.length} 份（同一个状态机的三个投影）：`);
		for (const path of written) console.log(`  ${path}`);
		break;
	}

	case "drift": {
		const ir = loadOrExit();
		const repo = resolve(process.cwd(), flag("repo") ?? positional[0] ?? ".");
		const report = scanAndDrift(ir, repo);
		console.log(formatDrift(report));
		process.exitCode = report.onlyInCode.length > 0 ? 1 : 0;
		break;
	}

	case "history": {
		const ir = loadOrExit();
		const sets = ir.changesets ?? [];
		if (sets.length === 0) {
			console.log("还没有变更记录。");
			break;
		}
		for (const cs of sets) {
			const counts = cs.changes.reduce<Record<string, number>>((acc, c) => {
				acc[c.op] = (acc[c.op] ?? 0) + 1;
				return acc;
			}, {});
			const summary = Object.entries(counts)
				.map(([k, n]) => `${k}×${n}`)
				.join(" ");
			console.log(`${cs.id}  ${cs.at.slice(0, 16)}  ${cs.reason}  [${summary}]`);
		}
		const tombstones = ir.tombstones ?? [];
		if (tombstones.length > 0) {
			console.log(`\n墓碑 ${tombstones.length} 条：`);
			for (const t of tombstones) console.log(`  ${t.assertion.id}  ${t.assertion.from} --${t.assertion.action}--> ${t.assertion.to}  （${t.reason}）`);
		}
		break;
	}

	default:
		console.error(
			`未知命令：${command}\n用法：\n  actormap init [产品名]\n  actormap validate\n  actormap report [--out f.md]\n  actormap render [--out .actormap/map.html]\n  actormap scan [repo] [--seed] [--force]\n  actormap drift [repo]\n  actormap export [--out 目录]\n  actormap change --reason "…" --file changes.json\n  actormap history\n  通用参数：--ir <path>`,
		);
		process.exit(2);
}

function joinSafe(...parts: string[]): string {
	return parts.join("/");
}
