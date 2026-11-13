/**
 * 本地工作台的 API 层。
 *
 * 和 pi 扩展共用同一批 handler —— 网页、CLI、agent 三条入口改的是同一份 IR，
 * 不存在"网页里加的角色 CLI 看不到"这种事。
 */
import { loadIR, resolveIRPath } from "../ir/store.js";
import { validate } from "../validate/validate.js";
import { addActorTool, addAssertionTool, changeTool, gateTool, validateTool } from "../extension/handlers.js";
import { createGenerate, resolveLlmConfig } from "./llm.js";
import { runTurn } from "./agent.js";
const FALLBACK_HINT = "没有可用的模型通道。设置 ACTORMAP_LLM_BASE / ACTORMAP_LLM_KEY / ACTORMAP_LLM_MODEL（或 GOOGLE_GEMINI_BASE_URL / GEMINI_API_KEY / GEMINI_MODEL）后重启服务。";
export function snapshot(cwd) {
    const ir = loadIR(resolveIRPath(cwd));
    const result = validate(ir);
    const edges = new Map();
    for (const a of ir.assertions) {
        const list = edges.get(a.entity) ?? [];
        list.push({ id: a.id, from: a.from, action: a.action, to: a.to, by: a.by, status: a.status, guards: a.guards });
        edges.set(a.entity, list);
    }
    const graphs = result.graphs.map((g) => ({
        entity: g.entity,
        states: g.states,
        initial: g.initial,
        terminal: g.terminal,
        edges: edges.get(g.entity) ?? [],
    }));
    return {
        product: ir.product,
        version: ir.version,
        actors: ir.actors,
        assertions: ir.assertions,
        terminals: ir.terminals,
        changesets: (ir.changesets ?? []).map((c) => ({ id: c.id, at: c.at, reason: c.reason, count: c.changes.length })),
        stats: result.stats,
        issues: result.issues,
        graphs,
    };
}
export function productName(ir) {
    return ir.product;
}
function bad(message) {
    return { status: 400, body: { error: message } };
}
export async function handleApi(req, cwd, deps = {}) {
    const body = (req.body ?? {});
    try {
        if (req.method === "GET" && req.path === "/api/state") {
            return { status: 200, body: snapshot(cwd) };
        }
        if (req.method === "POST" && req.path === "/api/actors") {
            if (!body.id || !body.name || !body.type)
                return bad("id / name / type 必填");
            const result = addActorTool(body, cwd);
            return { status: 200, body: { message: result.text, state: snapshot(cwd) } };
        }
        if (req.method === "POST" && req.path === "/api/assertions") {
            if (!body.from || !body.action || !body.to || !body.by)
                return bad("from / action / to / by 必填");
            const result = addAssertionTool(body, cwd);
            return { status: 200, body: { message: result.text, state: snapshot(cwd) } };
        }
        if (req.method === "POST" && req.path === "/api/terminals") {
            const state = String(body.state ?? "").trim();
            if (!state)
                return bad("state 必填");
            const result = validateTool({ acknowledge_terminal: [state] }, cwd);
            return { status: 200, body: { message: result.text, state: snapshot(cwd) } };
        }
        if (req.method === "POST" && req.path === "/api/change") {
            const reason = String(body.reason ?? "").trim();
            const changes = body.changes;
            if (!reason || !Array.isArray(changes) || changes.length === 0)
                return bad("reason 与 changes 必填");
            const result = changeTool({ reason, changes }, cwd);
            return { status: 200, body: { message: result.text, state: snapshot(cwd) } };
        }
        if (req.method === "POST" && req.path === "/api/gate") {
            const result = await gateTool({
                repo: typeof body.repo === "string" ? body.repo : ".",
                adapter: typeof body.adapter === "string" && body.adapter ? body.adapter : undefined,
                strict: Boolean(body.strict),
            }, cwd);
            return { status: 200, body: { message: result.text, details: result.details } };
        }
        if (req.method === "GET" && req.path === "/api/chat/status") {
            const config = resolveLlmConfig();
            return {
                status: 200,
                body: config ? { available: true, model: config.model } : { available: false, hint: FALLBACK_HINT },
            };
        }
        if (req.method === "POST" && req.path === "/api/chat") {
            const message = String(body.message ?? "").trim();
            if (!message)
                return bad("message 必填");
            const history = Array.isArray(body.history) ? body.history : [];
            const generate = deps.generate ?? (() => {
                const config = resolveLlmConfig();
                if (!config)
                    throw new Error(FALLBACK_HINT);
                return createGenerate(config);
            })();
            const result = await runTurn(cwd, [...history, { role: "user", text: message }], generate);
            return {
                status: 200,
                body: {
                    reply: result.reply,
                    events: result.events,
                    state: snapshot(cwd),
                },
            };
        }
        return { status: 404, body: { error: `没有这个接口：${req.method} ${req.path}` } };
    }
    catch (error) {
        return { status: 422, body: { error: error.message } };
    }
}
