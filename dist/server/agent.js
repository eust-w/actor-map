/**
 * 访谈 agent：模型负责问和说，改图必须走工具。
 *
 * 这是整套东西的核心 —— 对话不是聊天窗口，是**受约束的写入口**：
 * 模型只能通过 ir_* 工具改 IR，所以它没法编造一个不存在的状态，
 * 也没法悄悄改掉已经确认过的断言。
 *
 * 每一轮都把当前 IR 摘要重新注入 system prompt。
 * 对话历史只是缓存，IR 才是记忆 —— 这样聊到第 50 轮也不会忘。
 */
import { loadIR, resolveIRPath } from "../ir/store.js";
import { validate } from "../validate/validate.js";
import { addActorTool, addAssertionTool, validateTool } from "../extension/handlers.js";
export const TOOL_DECLARATIONS = [
    {
        name: "ir_add_actor",
        description: "登记一个动作发起者。包括非人类：system（定时任务/自动审核）、external（支付回调/第三方推送）、anonymous（未登录访客）、virtual（代理人）、batch（导入脚本）。",
        parameters: {
            type: "OBJECT",
            properties: {
                id: { type: "STRING", description: "短英文 id，如 employee" },
                name: { type: "STRING", description: "中文名" },
                type: {
                    type: "STRING",
                    enum: ["human", "anonymous", "system", "external", "virtual", "batch"],
                },
                trigger: { type: "STRING", description: "system/external 必填：什么事件让它动起来" },
            },
            required: ["id", "name", "type"],
        },
    },
    {
        name: "ir_add_assertion",
        description: "记录一条状态迁移：谁（by）在哪个状态（from）做了什么（action）之后变成什么（to）。创建对象用 from=∅。source 必须是用户原话片段，没有就留空。",
        parameters: {
            type: "OBJECT",
            properties: {
                entity: { type: "STRING", description: "实体名，默认 main" },
                from: { type: "STRING", description: "迁移前状态；创建用 ∅" },
                action: { type: "STRING", description: "动作名" },
                to: { type: "STRING", description: "迁移后状态" },
                by: { type: "STRING", description: "发起者 actor id，必须已登记" },
                guards: { type: "ARRAY", items: { type: "STRING" }, description: "成立条件，如『金额 > 5000』" },
                verify: { type: "STRING", description: "怎么判断成功了" },
                source: { type: "STRING", description: "用户原话片段" },
            },
            required: ["from", "action", "to", "by"],
        },
    },
    {
        name: "ir_validate",
        description: "跑一致性校验，返回错误和「该问什么」。每 2-3 条断言调用一次。确认某个状态是终态时，把它放进 acknowledge_terminal。",
        parameters: {
            type: "OBJECT",
            properties: {
                acknowledge_terminal: { type: "ARRAY", items: { type: "STRING" }, description: "确认是终态的状态名" },
            },
        },
    },
];
const RULES = `你是 ActorMap 的需求访谈员。目标：通过对话把产品流程聊成一张状态机，而不是写文档。

硬性规则：
1. 一次只问一个问题，问有答案的问题。不要罗列清单，不要一次抛三个问题。
2. 先摸清角色（包括没有界面的：定时任务、外部回调、导入脚本），再走流程。
3. 每得到一句业务描述，立刻调用 ir_add_assertion 落库，然后用一句话复述确认。
4. 每 2–3 条断言调用一次 ir_validate，把 error 优先问掉。
5. source 必须是用户的原话片段，不能自己概括，更不能编。没有就留空。
6. 用户说「不知道 / 以后再定」时，落断言并继续，不要追问第三次。
7. 不要自己写 JSON 文件，只能通过工具修改。

说话方式：像一个做过很多次需求评审的人 —— 简短、具体、只问有答案的问题。
不要用「让我们」「接下来我们需要」这类填充语。复述已经确认过的内容不要超过一句。`;
export function buildSystemPrompt(ir) {
    const result = validate(ir);
    const states = [...new Set(ir.assertions.flatMap((a) => [a.from, a.to]))].filter((s) => s !== "∅");
    const lines = [RULES, "", `## 当前状态`, `产品：${ir.product}（v${ir.version}）`];
    lines.push("", "角色：");
    if (ir.actors.length === 0)
        lines.push("（还没有登记任何角色 —— 先问清楚有谁）");
    for (const actor of ir.actors) {
        lines.push(`- ${actor.id}（${actor.name}，${actor.type}）${actor.trigger ? `触发：${actor.trigger}` : ""}`);
    }
    lines.push("", `断言（${ir.assertions.length} 条）：`);
    if (ir.assertions.length === 0)
        lines.push("（还没有任何断言）");
    for (const a of ir.assertions) {
        const guards = a.guards.length ? ` 条件[${a.guards.join(" && ")}]` : "";
        lines.push(`- ${a.id} ${a.by}: ${a.from} --${a.action}--> ${a.to}${guards}${a.source ? "" : " ⚠无原话"}`);
    }
    if (states.length > 0)
        lines.push("", `已知状态：${states.join("、")}`);
    const errors = result.issues.filter((i) => i.severity === "error");
    const warns = result.issues.filter((i) => i.severity === "warn");
    if (errors.length + warns.length > 0) {
        lines.push("", "待解决的问题（优先问 error）：");
        for (const issue of [...errors, ...warns].slice(0, 12)) {
            lines.push(`- [${issue.severity}] ${issue.code}：${issue.message} → 可以问：${issue.question}`);
        }
    }
    lines.push("", "下一轮：挑上面一个问题问，或者根据用户最新一句话落一条断言。");
    return lines.join("\n");
}
function toContents(history) {
    return history.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.text }],
    }));
}
function runTool(name, args, cwd) {
    try {
        if (name === "ir_add_actor") {
            const result = addActorTool({
                id: String(args.id ?? ""),
                name: String(args.name ?? ""),
                type: String(args.type ?? "human"),
                trigger: args.trigger ? String(args.trigger) : undefined,
            }, cwd);
            return { response: { ok: true, message: result.text }, event: { name, ok: true, detail: result.text } };
        }
        if (name === "ir_add_assertion") {
            const result = addAssertionTool({
                entity: args.entity ? String(args.entity) : undefined,
                from: String(args.from ?? ""),
                action: String(args.action ?? ""),
                to: String(args.to ?? ""),
                by: String(args.by ?? ""),
                guards: Array.isArray(args.guards) ? args.guards.map(String) : [],
                verify: args.verify ? String(args.verify) : "",
                source: args.source ? String(args.source) : "",
            }, cwd);
            return { response: { ok: true, message: result.text }, event: { name, ok: true, detail: result.text } };
        }
        if (name === "ir_validate") {
            const terminals = Array.isArray(args.acknowledge_terminal) ? args.acknowledge_terminal.map(String) : [];
            const result = validateTool({ acknowledge_terminal: terminals }, cwd);
            return { response: { ok: true, message: result.text }, event: { name, ok: true, detail: result.text } };
        }
        return { response: { ok: false, error: `没有这个工具：${name}` }, event: { name, ok: false, detail: "未知工具" } };
    }
    catch (error) {
        const message = error.message;
        // 把失败原因原样回喂给模型，让它自己纠正（比如 actor 没登记）
        return { response: { ok: false, error: message }, event: { name, ok: false, detail: message } };
    }
}
export async function runTurn(cwd, history, generate, options = {}) {
    const maxSteps = options.maxSteps ?? 4;
    const ir = loadIR(resolveIRPath(cwd));
    const system = buildSystemPrompt(ir);
    const contents = toContents(history);
    const events = [];
    for (let step = 0; step < maxSteps; step += 1) {
        const reply = await generate({ system, contents, tools: TOOL_DECLARATIONS });
        if (reply.calls.length === 0) {
            return { reply: reply.text || "（模型没有返回内容）", events };
        }
        contents.push({
            role: "model",
            parts: reply.calls.map((call) => ({ functionCall: { name: call.name, args: call.args } })),
        });
        const responses = [];
        for (const call of reply.calls) {
            const outcome = runTool(call.name, call.args, cwd);
            events.push(outcome.event);
            responses.push({ functionResponse: { name: call.name, response: outcome.response } });
        }
        contents.push({ role: "user", parts: responses });
    }
    return { reply: "（工具调用次数达到上限，先停一下——要接着聊吗？）", events };
}
