/**
 * ActorMap · pi 扩展
 *
 * 模型没法直接写 ir.json —— 只能走这几个工具。格式错误在类型边界就被挡住，
 * 幻觉没有落库的路径。这是把"防幻觉"从提示词下沉到工具契约。
 *
 * 实际逻辑都在 handlers.ts 里，这一层只声明 schema。
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Change } from "../ir/types.ts";
import {
	addActorTool,
	addAssertionTool,
	changeTool,
	driftTool,
	exportTool,
	mapSummary,
	scanTool,
	validateTool,
} from "./handlers.ts";
import type {
	AddActorParams,
	AddAssertionParams,
	ChangeParams,
	DriftParams,
	ExportParams,
	ScanParams,
	ValidateParams,
} from "./handlers.ts";

const ACTOR_TYPE_SCHEMA = Type.Union([
	Type.Literal("human"),
	Type.Literal("anonymous"),
	Type.Literal("system"),
	Type.Literal("external"),
	Type.Literal("virtual"),
	Type.Literal("batch"),
]);

const ASSERTION_FIELDS = {
	entity: Type.Optional(Type.String({ description: "实体名，默认 main" })),
	from: Type.String({ description: "迁移前状态；创建对象用 ∅" }),
	action: Type.String({ description: "动作名" }),
	to: Type.String({ description: "迁移后状态；对象消亡用 ∅" }),
	by: Type.String({ description: "发起者 actor id，必须已登记" }),
	guards: Type.Optional(Type.Array(Type.String(), { description: "成立条件，如『金额 > 5000』" })),
	verify: Type.Optional(Type.String({ description: "怎么判断成功了" })),
	source: Type.Optional(Type.String({ description: "访谈对象原话片段" })),
	status: Type.Optional(Type.Union([Type.Literal("confirmed"), Type.Literal("assumed")])),
};

const CHANGE_SCHEMA = Type.Object({
	op: Type.Union([Type.Literal("add"), Type.Literal("modify"), Type.Literal("remove"), Type.Literal("ack_terminal")]),
	id: Type.Optional(Type.String({ description: "modify / remove 时的断言 id" })),
	assertion: Type.Optional(Type.Object(ASSERTION_FIELDS, { description: "op=add 时的新断言" })),
	patch: Type.Optional(
		Type.Object(
			{
				entity: Type.Optional(Type.String()),
				from: Type.Optional(Type.String()),
				action: Type.Optional(Type.String()),
				to: Type.Optional(Type.String()),
				by: Type.Optional(Type.String()),
				guards: Type.Optional(Type.Array(Type.String())),
				verify: Type.Optional(Type.String()),
				source: Type.Optional(Type.String()),
				status: Type.Optional(Type.Union([Type.Literal("confirmed"), Type.Literal("assumed")])),
			},
			{ description: "op=modify 时要改的字段" },
		),
	),
	state: Type.Optional(Type.String({ description: "op=ack_terminal 时要确认的终态" })),
});

function cwdOf(ctx: unknown): string {
	const cwd = (ctx as { cwd?: string } | undefined)?.cwd;
	return typeof cwd === "string" && cwd.length > 0 ? cwd : process.cwd();
}

export default function actorMapExtension(pi: ExtensionAPI) {
	pi.registerTool(
		defineTool({
			name: "ir_add_actor",
			label: "登记角色",
			description:
				"登记一个动作发起者，包括非人类：system（定时任务/自动审核）、external（支付回调/第三方推送）、anonymous（未登录访客）、virtual（代理人）、batch（导入脚本）。同 id 重复调用会更新。",
			parameters: Type.Object({
				id: Type.String({ description: "短英文 id，如 employee / sys_sweeper" }),
				name: Type.String({ description: "中文名" }),
				type: ACTOR_TYPE_SCHEMA,
				trigger: Type.Optional(Type.String({ description: "system/external 必填：什么事件让它动起来" })),
				note: Type.Optional(Type.String({ description: "补充说明" })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const result = addActorTool(params as AddActorParams, cwdOf(ctx));
				return { content: [{ type: "text", text: result.text }], details: result.details };
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "ir_add_assertion",
			label: "记一条断言",
			description:
				"记下一条状态迁移：谁（by）在哪个状态（from）做了什么（action）之后变成什么（to）。创建对象用 from=∅，对象消亡用 to=∅。source 必须是访谈对象的原话片段，没有就留空（会被标为待确认）。",
			parameters: Type.Object(ASSERTION_FIELDS),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const result = addAssertionTool(params as AddAssertionParams, cwdOf(ctx));
				return { content: [{ type: "text", text: result.text }], details: result.details };
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "ir_change",
			label: "改需求",
			description:
				"以变更集方式修改已确认的需求，自动算出影响面（受影响状态/角色、要重跑的测试、新引入或消除的缺口）。必须写 reason：为什么改。op 有 add / modify / remove / ack_terminal。",
			parameters: Type.Object({
				reason: Type.String({ description: "为什么改 —— 半年后这条最值钱" }),
				changes: Type.Array(CHANGE_SCHEMA, { description: "变更项列表" }),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const result = changeTool(params as unknown as ChangeParams, cwdOf(ctx));
				return { content: [{ type: "text", text: result.text }], details: result.details };
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "ir_validate",
			label: "校验地图",
			description:
				"跑零 LLM 的一致性校验：可达性、死锁、分支重叠、区间空洞、孤儿角色、未确认终态…返回错误和「该问什么」。每 2-3 条断言调用一次。确认某些没有后续动作的状态就是终态时，传 acknowledge_terminal。",
			parameters: Type.Object({
				acknowledge_terminal: Type.Optional(
					Type.Array(Type.String(), { description: "确认是终态的状态，形如 order:closed 或直接 closed" }),
				),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const result = validateTool(params as ValidateParams, cwdOf(ctx));
				return { content: [{ type: "text", text: result.text }], details: result.details };
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "ir_scan",
			label: "扫仓库出骨架",
			description:
				"扫描代码仓库，抽出实体、状态、状态迁移、角色，生成可确认的骨架地图。只有带 file:line 证据的迁移才进图，其余变成问题。seed=true 写入 IR（已存在需 force）。",
			parameters: Type.Object({
				path: Type.Optional(Type.String({ description: "仓库路径，默认当前目录" })),
				seed: Type.Optional(Type.Boolean({ description: "把扫描结果写入 IR" })),
				force: Type.Optional(Type.Boolean({ description: "IR 已存在时是否覆盖" })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const result = scanTool(params as ScanParams, cwdOf(ctx));
				return { content: [{ type: "text", text: result.text }], details: result.details };
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "ir_export",
			label: "导出给下游",
			description:
				"把断言清单导出成三份可直接使用的东西：tools.json（给 agent 的工具表）、openapi.yaml（给后端）、acceptance.md（给 QA 的验收用例，含反例）。三者来自同一个状态机，所以不会互相漂移。",
			parameters: Type.Object({
				dir: Type.Optional(Type.String({ description: "输出目录，默认 .actormap/export" })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const result = exportTool(params as ExportParams, cwdOf(ctx));
				return { content: [{ type: "text", text: result.text }], details: result.details };
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "ir_drift",
			label: "漂移检测",
			description:
				"把代码仓库扫一遍，和已确认的断言做比对：代码里有但 IR 没确认的（偷偷加的需求）、IR 确认了但代码里没有的（没实现）。两个方向都值得追问。",
			parameters: Type.Object({
				path: Type.Optional(Type.String({ description: "仓库路径，默认当前目录" })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const result = driftTool(params as DriftParams, cwdOf(ctx));
				return { content: [{ type: "text", text: result.text }], details: result.details };
			},
		}),
	);

	pi.registerCommand("map", {
		description: "重新校验并生成清单与地图（.actormap/map.md / map.html）",
		handler: async (args, ctx) => {
			const summary = mapSummary(cwdOf(ctx), args.trim() || undefined);
			if (ctx.hasUI) ctx.ui.notify(summary, summary.includes("0 错误") ? "info" : "warn");
			else console.log(summary);
		},
	});
}

export type { Change };
