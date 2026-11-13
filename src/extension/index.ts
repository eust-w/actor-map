/**
 * ActorMap · pi 扩展
 *
 * 只做三件事，而且只让模型通过它们改 IR —— 这是把"防幻觉"从提示词下沉到类型边界：
 *   1. ir_add_actor      登记角色 / 非人发起者
 *   2. ir_add_assertion  落一条断言（状态迁移）
 *   3. ir_validate       零 LLM 校验，产出下一轮该问什么
 *
 * 模型没有 write/edit 权限去碰 ir.json，格式错误在工具边界就被拒。
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import {
	acknowledgeTerminals,
	addActor,
	addAssertion,
	bumpVersion,
	loadIR,
	resolveIRPath,
	saveIR,
} from "../ir/store.ts";
import { formatIssues, validate } from "../validate/validate.ts";
import { renderChecklist } from "../report/checklist.ts";

const ACTOR_TYPE_SCHEMA = Type.Union([
	Type.Literal("human"),
	Type.Literal("anonymous"),
	Type.Literal("system"),
	Type.Literal("external"),
	Type.Literal("virtual"),
	Type.Literal("batch"),
]);

function cwdOf(ctx: unknown): string {
	const cwd = (ctx as { cwd?: string } | undefined)?.cwd;
	return typeof cwd === "string" && cwd.length > 0 ? cwd : process.cwd();
}

function persist(ctx: unknown, product?: string) {
	const path = resolveIRPath(cwdOf(ctx));
	const ir = loadIR(path, product);
	return { path, ir, cwd: cwdOf(ctx) };
}

function writeChecklist(cwd: string, ir: ReturnType<typeof loadIR>): string {
	const result = validate(ir);
	const markdown = renderChecklist(ir, result);
	mkdirSync(join(cwd, ".actormap"), { recursive: true });
	const mapPath = join(cwd, ".actormap", "map.md");
	writeFileSync(mapPath, markdown, "utf8");
	return mapPath;
}

export default function actorMapExtension(pi: ExtensionAPI) {
	pi.registerTool(
		defineTool({
			name: "ir_add_actor",
			label: "登记角色",
			description:
				"登记一个动作发起者。包括非人类角色：system（定时任务/自动审核）、external（支付回调/第三方推送）、anonymous（未登录访客）、virtual（代理人）、batch（导入脚本）。同 id 重复调用会更新。",
			parameters: Type.Object({
				id: Type.String({ description: "短英文 id，如 employee / a_sweeper" }),
				name: Type.String({ description: "中文名，如 员工 / 超时关单任务" }),
				type: ACTOR_TYPE_SCHEMA,
				trigger: Type.Optional(
					Type.String({ description: "system/external 必填：什么事件让它动起来" }),
				),
				note: Type.Optional(Type.String({ description: "补充说明" })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const { path, ir, cwd } = persist(ctx);
				const actor = addActor(ir, params);
				saveIR(path, ir);
				writeChecklist(cwd, ir);
				const total = ir.actors.length;
				return {
					content: [
						{
							type: "text",
							text: `已登记角色 ${actor.name}(${actor.id}) · ${actor.type}。当前共 ${total} 个角色。`,
						},
					],
					details: { actor, actors: total, irPath: path },
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "ir_add_assertion",
			label: "记一条断言",
			description:
				"记下一条状态迁移：谁（by）在哪个状态（from）做了什么（action）之后变成什么（to）。这是需求确认的唯一落库方式。source 必须是访谈对象的原话片段，没有就留空（会被标为待确认）。",
			parameters: Type.Object({
				entity: Type.Optional(Type.String({ description: "实体名，默认 main" })),
				from: Type.String({ description: "迁移前的状态，如 draft" }),
				action: Type.String({ description: "动作名，如 submit" }),
				to: Type.String({ description: "迁移后的状态，如 submitted" }),
				by: Type.String({ description: "发起者 actor id，必须已登记" }),
				guards: Type.Optional(Type.Array(Type.String(), { description: "成立条件" })),
				verify: Type.Optional(Type.String({ description: "怎么判断成功了" })),
				source: Type.Optional(Type.String({ description: "访谈对象原话片段" })),
				status: Type.Optional(Type.Union([Type.Literal("confirmed"), Type.Literal("assumed")])),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const { path, ir, cwd } = persist(ctx);
				const outcome = addAssertion(ir, params);
				if (!outcome.ok) throw new Error(outcome.error);
				bumpVersion(ir);
				saveIR(path, ir);
				const mapPath = writeChecklist(cwd, ir);
				const result = validate(ir);
				const text = [
					`已记录 ${outcome.assertion.id}：${outcome.assertion.by} ${outcome.assertion.from} --${outcome.assertion.action}--> ${outcome.assertion.to}`,
					...(outcome.warnings.length > 0 ? outcome.warnings.map((w) => `⚠ ${w}`) : []),
					`当前 ${result.stats.assertions} 条断言 · ${result.stats.errors} 错误 · ${result.stats.warnings} 待确认（清单：${mapPath}）`,
				].join("\n");
				return {
					content: [{ type: "text", text }],
					details: { assertion: outcome.assertion, warnings: outcome.warnings, stats: result.stats },
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "ir_validate",
			label: "校验地图",
			description:
				"跑零 LLM 的一致性校验，返回错误和「该问什么」的清单。每 2-3 条断言调用一次。若确认某些没有后续动作的状态就是终态，用 acknowledge_terminal 传 '实体:状态'。",
			parameters: Type.Object({
				acknowledge_terminal: Type.Optional(
					Type.Array(Type.String(), { description: "确认是终态的状态，形如 main:closed" }),
				),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const { path, ir, cwd } = persist(ctx);
				const acknowledged = acknowledgeTerminals(ir, params.acknowledge_terminal ?? []);
				if (acknowledged.length > 0) saveIR(path, ir);
				const result = validate(ir);
				const clean = result.stats.errors === 0 && result.stats.assertions > 0;
				if (clean && ir.version > 0) bumpVersion(ir);
				if (clean) saveIR(path, ir);
				const mapPath = writeChecklist(cwd, ir);
				const text = `${formatIssues(result)}\n\n清单：${mapPath}${clean ? `\n\n这一版自洽，可以定稿 v${ir.version}。` : ""}`;
				return {
					content: [{ type: "text", text }],
					details: { stats: result.stats, issues: result.issues, acknowledged, mapPath },
				};
			},
		}),
	);

	pi.registerCommand("map", {
		description: "重新校验并生成断言清单（.actormap/map.md）",
		handler: async (args, ctx) => {
			const { path, ir, cwd } = persist(ctx, args.trim() || undefined);
			const result = validate(ir);
			const mapPath = writeChecklist(cwd, ir);
			const summary = `${ir.product} v${ir.version} · 断言 ${result.stats.assertions}（✔${result.stats.confirmed}/⚠${result.stats.assumed}） · ${result.stats.errors} 错误 / ${result.stats.warnings} 待确认\n清单：${mapPath}\nIR：${path}`;
			if (ctx.hasUI) ctx.ui.notify(summary, result.stats.errors > 0 ? "warn" : "info");
			else console.log(summary);
		},
	});
}
