/**
 * IR = 需求确认的唯一真相源。
 *
 * 只有两样东西是"作者写的"：actor 和 assertion。
 * 实体、状态、入口、终态全部从 assertion 推导 —— 少写一种数据，就少一种不一致。
 */

export type ActorType =
	| "human" // 员工、主管
	| "anonymous" // 未登录访客
	| "system" // 定时任务、自动审核（没有 UI 入口，只有触发条件）
	| "external" // 支付回调、第三方推送
	| "virtual" // 代理人、委托、坐席
	| "batch"; // 导入脚本、迁移工具

export const ACTOR_TYPES: ActorType[] = ["human", "anonymous", "system", "external", "virtual", "batch"];

export interface Actor {
	id: string;
	name: string;
	type: ActorType;
	/** system / external 这类 actor 靠什么事件动起来 */
	trigger?: string;
	note?: string;
}

export type AssertionStatus = "confirmed" | "assumed";

/**
 * 伪状态：对象还不存在。
 * `∅ --create--> draft` 是创建，`draft --discard--> ∅` 是消亡。
 * 把「入口」显式化，就不用猜哪个状态是起点了。
 */
export const EMPTY_STATE = "∅";
export const EMPTY_ALIASES = new Set(["∅", "-", "none", "(none)", "null", ""]);

/**
 * 一条断言 = 状态机里的一条迁移。
 * (entity, from, action) 必须唯一，否则产品行为不确定。
 */
export interface Assertion {
	id: string;
	entity: string;
	from: string;
	action: string;
	to: string;
	/** 谁发起 */
	by: string;
	/** 什么条件下才成立 */
	guards: string[];
	/** 怎么判断成功了 */
	verify: string;
	/** 访谈对象的原话片段 —— 防幻觉的锚点 */
	source: string;
	status: AssertionStatus;
}

export interface IRFile {
	product: string;
	version: number;
	updatedAt: string;
	actors: Actor[];
	assertions: Assertion[];
	/** 已被确认过的终态，形如 "order:closed"；只写状态名表示对所有实体生效 */
	terminals: string[];
	/** 变更历史：改需求不是一个新文档，是一次可追溯的差量 */
	changesets?: ChangeSet[];
	/** 删掉的断言不静默消失，留墓碑 */
	tombstones?: Tombstone[];
}

export type Change =
	| { op: "add"; assertion: Omit<Assertion, "id"> & { id?: string } }
	| { op: "modify"; id: string; patch: Partial<Pick<Assertion, "from" | "action" | "to" | "by" | "guards" | "verify" | "source" | "status">> }
	| { op: "remove"; id: string }
	| { op: "ack_terminal"; state: string };

export interface ChangeSet {
	id: string;
	at: string;
	/** 为什么改 —— 半年后最贵的信息 */
	reason: string;
	changes: Change[];
}

export interface Tombstone {
	assertion: Assertion;
	at: string;
	reason: string;
	changeSet: string;
}

export function emptyIR(product: string): IRFile {
	return {
		product,
		version: 0,
		updatedAt: new Date().toISOString(),
		actors: [],
		assertions: [],
		terminals: [],
		changesets: [],
		tombstones: [],
	};
}

export function terminalKey(entity: string, state: string): string {
	return `${entity}:${state}`;
}
