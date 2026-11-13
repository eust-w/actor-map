#!/usr/bin/env node
/**
 * 不依赖 pi 的命令行入口：校验 + 出清单。
 * 用途：CI 门禁、把 IR 交给编码 agent 前的自检。
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadIR, resolveIRPath, saveIR } from "./ir/store.ts";
import { emptyIR } from "./ir/types.ts";
import { formatIssues, validate } from "./validate/validate.ts";
import { renderChecklist } from "./report/checklist.ts";

const argv = process.argv.slice(2);
const command = argv[0] ?? "report";
const flag = (name: string): string | undefined => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : undefined;
};

const product = flag("product") ?? "未命名产品";
const irPath = resolveIRPath(process.cwd(), flag("ir"));
const positional = argv.slice(1).filter((a) => !a.startsWith("--") && a !== product && a !== flag("ir"));

if (command === "init") {
	if (existsSync(irPath)) {
		console.error(`已存在：${irPath}，未覆盖。`);
		process.exit(1);
	}
	const ir = emptyIR(positional[0] ?? product);
	mkdirSync(dirname(irPath), { recursive: true });
	saveIR(irPath, ir);
	console.log(`已创建 ${irPath}`);
	process.exit(0);
}

const ir = loadIR(irPath, product);
const result = validate(ir);

if (command === "validate") {
	console.log(formatIssues(result, 200));
	process.exit(result.stats.errors > 0 ? 1 : 0);
}

if (command === "report") {
	const markdown = renderChecklist(ir, result);
	const outFlag = flag("out");
	if (outFlag) {
		const out = resolve(process.cwd(), outFlag);
		mkdirSync(dirname(out), { recursive: true });
		writeFileSync(out, markdown, "utf8");
		console.log(`写入 ${out}（${result.stats.errors} 错误 / ${result.stats.warnings} 待确认）`);
	} else {
		console.log(markdown);
	}
	process.exit(result.stats.errors > 0 ? 1 : 0);
}

console.error(`未知命令：${command}\n用法：\n  cli.ts init [产品名]\n  cli.ts validate [--ir 路径]\n  cli.ts report [--ir 路径] [--out 输出.md]`);
process.exit(2);
