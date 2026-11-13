/**
 * 契约测试的执行器：把真实实现接进参考状态机。
 *
 * 分工很干净：
 *   参考状态机（runner.mjs，从 IR 编译）负责「应该怎样」；
 *   适配器（你的实现）负责「实际怎样」；
 *   两边跑同一组输入，结论不一致就是契约破了。
 *
 * 适配器只交出三个能力，不需要改你的业务代码：
 *   create(actor, ctx)              → id
 *   act(id, action, ctx, actor)     → 抛错或返回 { ok: false } 表示拒绝
 *   state(id)                       → 当前状态
 *   seed(state, ctx, actor)?        → 可选：直接把对象放到某状态（拿不到可达路径时才用）
 */

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { IRFile } from "../ir/types.ts";
import { EMPTY_STATE } from "../ir/types.ts";
import { exportRunner } from "../export/runner.ts";
import { deriveCases, pathTo } from "./cases.ts";
import type { TestCase } from "./cases.ts";

export type MaybeAsync<T> = T | Promise<T>;

export interface ConformanceAdapter {
	name?: string;
	create(actor: string, ctx: Record<string, number>): MaybeAsync<string>;
	act(id: string, action: string, ctx: Record<string, number>, actor: string): MaybeAsync<unknown>;
	state(id: string): MaybeAsync<string>;
	seed?(state: string, ctx: Record<string, number>, actor: string): MaybeAsync<string>;
}

export interface CaseResult {
	case: TestCase;
	outcome: "pass" | "fail" | "skip";
	expected: { allowed: boolean; to?: string };
	actual?: { allowed: boolean; state?: string; error?: string };
	detail?: string;
}

export interface ConformanceReport {
	adapter: string;
	product: string;
	version: number;
	passed: number;
	failed: number;
	skipped: number;
	results: CaseResult[];
	/** 推导阶段就跳过的东西（解析不了的条件） */
	unchecked: Array<{ assertionId: string; reason: string }>;
	durationMs: number;
}

interface RunnerModule {
	apply(
		from: string,
		action: string,
		ctx: Record<string, number>,
		by: string,
	): { allowed: boolean; to: string | null; reason?: string; id?: string };
	create(entity: string, by: string): string | null;
}

/**
 * 把 IR 编译成 runner.mjs 再 import —— 用真实交付物当裁判，而不是另写一套逻辑。
 * 文件名带内容哈希，避免同一进程里 import 到旧版本。
 */
async function loadRunner(ir: IRFile): Promise<RunnerModule> {
	const source = `${exportRunner(ir)}\nexport {}\n`;
	const hash = createHash("sha1").update(source).digest("hex").slice(0, 12);
	const file = join(tmpdir(), `actormap-runner-${hash}.mjs`);
	writeFileSync(file, source, "utf8");
	return (await import(`${pathToFileURL(file).href}?v=${hash}`)) as RunnerModule;
}

function isRejection(value: unknown): value is { ok: false } {
	return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false;
}

interface Setup {
	id?: string;
	ok: boolean;
	state?: string;
	reason?: string;
}

/** 把实现里的对象推进到断言的 from 状态 */
async function setup(
	adapter: ConformanceAdapter,
	ir: IRFile,
	testCase: TestCase,
): Promise<Setup> {
	const entity = testCase.entity;

	// 创建类断言：对象此刻还不该存在
	if (testCase.from === EMPTY_STATE) return { ok: true };

	const steps = pathTo(ir, entity, testCase.from);
	if (!steps) {
		if (!adapter.seed) {
			return { ok: false, reason: `IR 里没有从 ∅ 到 ${testCase.from} 的可达路径，适配器也没提供 seed()` };
		}
		try {
			const id = await adapter.seed(testCase.from, { ...testCase.ctx }, testCase.by);
			return { ok: true, id, state: await adapter.state(id) };
		} catch (error) {
			return { ok: false, reason: `seed() 失败：${(error as Error).message}` };
		}
	}

	let id: string | undefined;
	for (const [index, step] of steps.entries()) {
		// 用本次用例的输入建对象（金额之类的业务数据在创建时就定了），
		// 同时保证路径每一步的条件也成立，否则这一步会失败 —— 那时就退化成 skip
		const ctx = { ...step.ctx, ...testCase.ctx };
		try {
			if (index === 0) {
				id = await adapter.create(step.by, ctx);
			} else {
				await adapter.act(id as string, step.action, ctx, step.by);
			}
		} catch (error) {
			return { ok: false, reason: `准备前置状态时失败在 ${step.action}：${(error as Error).message}` };
		}
	}
	if (!id) return { ok: false, reason: "适配器没有返回对象 id" };
	const state = await adapter.state(id);
	if (state !== testCase.from) {
		return { ok: false, reason: `前置状态不对：期望 ${testCase.from}，实现是 ${state}` };
	}
	return { ok: true, id, state };
}

async function readState(adapter: ConformanceAdapter, id?: string): Promise<string | undefined> {
	if (!id) return undefined;
	try {
		return await adapter.state(id);
	} catch {
		return undefined;
	}
}

async function attempt(
	adapter: ConformanceAdapter,
	setupResult: Setup,
	testCase: TestCase,
): Promise<{ allowed: boolean; state?: string; error?: string }> {
	if (testCase.from === EMPTY_STATE) {
		try {
			const id = await adapter.create(testCase.by, { ...testCase.ctx });
			return { allowed: true, state: await readState(adapter, id) };
		} catch (error) {
			return { allowed: false, error: (error as Error).message };
		}
	}

	const id = setupResult.id as string;
	try {
		const outcome = await adapter.act(id, testCase.action, { ...testCase.ctx }, testCase.by);
		if (isRejection(outcome)) {
			return { allowed: false, state: await readState(adapter, id), error: "act 返回 ok:false" };
		}
		return { allowed: true, state: await readState(adapter, id) };
	} catch (error) {
		// 拒绝也要看状态有没有被改脏 —— 半途失败留下脏数据是最常见的实现 bug
		return { allowed: false, state: await readState(adapter, id), error: (error as Error).message };
	}
}

export async function runConformance(
	ir: IRFile,
	adapterPath: string,
	options: { filter?: string } = {},
): Promise<ConformanceReport> {
	const mod = (await import(pathToFileURL(adapterPath).href)) as { default?: ConformanceAdapter };
	const adapter = mod.default;
	if (!adapter) throw new Error(`${adapterPath} 没有 export default 适配器`);
	return runConformanceWithAdapter(ir, adapter, options);
}

export async function runConformanceWithAdapter(
	ir: IRFile,
	adapter: ConformanceAdapter,
	options: { filter?: string } = {},
): Promise<ConformanceReport> {
	const started = Date.now();
	const runner = await loadRunner(ir);
	const { cases, skipped } = deriveCases(ir);
	const selected = options.filter
		? cases.filter((c) => c.assertionId.includes(options.filter as string) || c.kind === options.filter)
		: cases;

	const results: CaseResult[] = [];

	for (const testCase of selected) {
		const expectedResult = runner.apply(testCase.from, testCase.action, testCase.ctx, testCase.by);
		const expected = { allowed: expectedResult.allowed, to: expectedResult.to ?? undefined };

		const setupResult = await setup(adapter, ir, testCase);
		if (!setupResult.ok) {
			results.push({
				case: testCase,
				outcome: "skip",
				expected,
				detail: setupResult.reason,
			});
			continue;
		}

		const actual = await attempt(adapter, setupResult, testCase);
		const problems: string[] = [];

		if (actual.allowed !== expected.allowed) {
			problems.push(
				expected.allowed
					? `期望执行成功，实现拒绝了（${actual.error ?? "无错误信息"}）`
					: `期望被拒绝，实现却放行了（状态 ${actual.state ?? "未知"}）`,
			);
		} else if (expected.allowed && testCase.expectTo) {
			if (actual.state !== testCase.expectTo) {
				problems.push(`期望落到 ${testCase.expectTo}，实际是 ${actual.state}`);
			}
		} else if (!expected.allowed && testCase.from !== EMPTY_STATE) {
			// 被拒绝时状态必须没动
			if (actual.state !== undefined && actual.state !== setupResult.state) {
				problems.push(`被拒绝后状态不应变化，但 ${setupResult.state} 变成了 ${actual.state}`);
			}
		}

		results.push({
			case: testCase,
			outcome: problems.length === 0 ? "pass" : "fail",
			expected,
			actual,
			detail: problems.join("；") || undefined,
		});
	}

	const passed = results.filter((r) => r.outcome === "pass").length;
	const failed = results.filter((r) => r.outcome === "fail").length;
	const skippedCount = results.filter((r) => r.outcome === "skip").length;

	return {
		adapter: adapter.name ?? "未命名适配器",
		product: ir.product,
		version: ir.version,
		passed,
		failed,
		skipped: skippedCount,
		results,
		unchecked: skipped,
		durationMs: Date.now() - started,
	};
}
