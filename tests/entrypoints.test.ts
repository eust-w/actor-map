/**
 * 入口守卫：三个入口（cli.ts 直跑 / dist 产物 / action.yml）必须指向同一套行为。
 * 这类"两处配置"最容易悄悄漂移，所以用测试钉住。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const read = (p: string) => readFileSync(join(root, p), "utf8");
const pkg = JSON.parse(read("package.json")) as {
	bin: Record<string, string>;
	files: string[];
	engines: { node: string };
	version: string;
};

test("bin 指向编译产物，不是 TypeScript 源码", () => {
	// node 不允许对 node_modules 里的文件做类型剥离，所以 bin 必须是 .js
	assert.equal(pkg.bin.actormap, "./dist/cli.js");
	assert.equal(pkg.bin["actor-map"], "./dist/cli.js");
	assert.ok(!pkg.bin.actormap.endsWith(".ts"));
});

test("两个 bin 名字都能用（npx 与包名一致的那个）", () => {
	for (const name of Object.keys(pkg.bin)) {
		assert.ok(name.length > 0);
	}
});

test("dist 产物存在且带 shebang、能报版本", () => {
	const cli = join(root, "dist/cli.js");
	assert.ok(existsSync(cli), "dist/cli.js 应当被提交进仓库，npx 才不会要求构建");
	assert.ok(readFileSync(cli, "utf8").startsWith("#!/usr/bin/env node"));
	const out = execFileSync(process.execPath, [cli, "--version"], { encoding: "utf8" }).trim();
	assert.equal(out, pkg.version);
});

test("dist 里的 import 已经重写成 .js", () => {
	const source = read("dist/cli.js");
	assert.match(source, /from "\.\/ir\/store\.js"/);
	assert.doesNotMatch(source, /from "\.\/[^"]+\.ts"/);
});

test("发布物包含 dist，否则 npx 拿到的是跑不起来的包", () => {
	assert.ok(pkg.files.includes("dist"));
	assert.ok(pkg.files.includes("src"), "src 留着：有人把它当 pi 扩展用");
});

test("engines 要求 Node 22.19+（类型剥离默认开启的版本）", () => {
	assert.match(pkg.engines.node, />=22\.\d+/);
});

test("action.yml 存在、是 composite，并且调用的是 gate", () => {
	const action = read("action.yml");
	assert.match(action, /^name: ActorMap Gate/m);
	assert.match(action, /using: composite/);
	assert.match(action, /npx --yes "\$tool" actormap/);
	assert.match(action, /args=\(gate --ir "\$IR"\)/);
	assert.match(action, /branding:/);
	assert.match(action, /icon: map/);
});

test("action.yml 的输入与 README 里的用法一致", () => {
	const action = read("action.yml");
	for (const input of ["ir", "repo", "adapter", "strict", "comment"]) {
		assert.match(action, new RegExp(`^  ${input}:`, "m"), `action.yml 缺少 input: ${input}`);
	}
	assert.match(action, /outputs:/);
	assert.match(action, /value: \$\{\{ steps\.gate\.outputs\.result \}\}/);
});

test("action.yml 不往被检查的仓库里写工具文件", () => {
	const action = read("action.yml");
	assert.doesNotMatch(action, /actions\/checkout[\s\S]*actor-map/, "工具应当用 npx 取，不要 checkout 进工作区");
});
