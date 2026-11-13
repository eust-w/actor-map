/**
 * 本地工作台的 API 层。
 *
 * 和 pi 扩展共用同一批 handler —— 网页、CLI、agent 三条入口改的是同一份 IR，
 * 不存在"网页里加的角色 CLI 看不到"这种事。
 */

import { loadIR, resolveIRPath } from "../ir/store.ts";
import { validate } from "../validate/validate.ts";
import { addActorTool, addAssertionTool, changeTool, gateTool, validateTool } from "../extension/handlers.ts";
import type { AddActorParams, AddAssertionParams, ChangeParams, GateParams } from "../extension/handlers.ts";
import type { IRFile } from "../ir/types.ts";

export interface ApiRequest {
	method: string;
	path: string;
	body?: unknown;
}

export interface ApiResponse {
	status: number;
	body: unknown;
}

interface GraphEdge {
	id: string;
	from: string;
	action: string;
	to: string;
	by: string;
	status: string;
	guards: string[];
}

interface GraphView {
	entity: string;
	states: string[];
	initial: string[];
	terminal: string[];
	edges: GraphEdge[];
}

export function snapshot(cwd: string) {
	const ir = loadIR(resolveIRPath(cwd));
	const result = validate(ir);
	const edges = new Map<string, GraphEdge[]>();
	for (const a of ir.assertions) {
		const list = edges.get(a.entity) ?? [];
		list.push({ id: a.id, from: a.from, action: a.action, to: a.to, by: a.by, status: a.status, guards: a.guards });
		edges.set(a.entity, list);
	}
	const graphs: GraphView[] = result.graphs.map((g) => ({
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

export function productName(ir: IRFile): string {
	return ir.product;
}

function bad(message: string): ApiResponse {
	return { status: 400, body: { error: message } };
}

export async function handleApi(req: ApiRequest, cwd: string): Promise<ApiResponse> {
	const body = (req.body ?? {}) as Record<string, unknown>;

	try {
		if (req.method === "GET" && req.path === "/api/state") {
			return { status: 200, body: snapshot(cwd) };
		}

		if (req.method === "POST" && req.path === "/api/actors") {
			if (!body.id || !body.name || !body.type) return bad("id / name / type 必填");
			const result = addActorTool(body as unknown as AddActorParams, cwd);
			return { status: 200, body: { message: result.text, state: snapshot(cwd) } };
		}

		if (req.method === "POST" && req.path === "/api/assertions") {
			if (!body.from || !body.action || !body.to || !body.by) return bad("from / action / to / by 必填");
			const result = addAssertionTool(body as unknown as AddAssertionParams, cwd);
			return { status: 200, body: { message: result.text, state: snapshot(cwd) } };
		}

		if (req.method === "POST" && req.path === "/api/terminals") {
			const state = String(body.state ?? "").trim();
			if (!state) return bad("state 必填");
			const result = validateTool({ acknowledge_terminal: [state] }, cwd);
			return { status: 200, body: { message: result.text, state: snapshot(cwd) } };
		}

		if (req.method === "POST" && req.path === "/api/change") {
			const reason = String(body.reason ?? "").trim();
			const changes = body.changes;
			if (!reason || !Array.isArray(changes) || changes.length === 0) return bad("reason 与 changes 必填");
			const result = changeTool({ reason, changes } as unknown as ChangeParams, cwd);
			return { status: 200, body: { message: result.text, state: snapshot(cwd) } };
		}

		if (req.method === "POST" && req.path === "/api/gate") {
			const result = await gateTool(
				{
					repo: typeof body.repo === "string" ? body.repo : ".",
					adapter: typeof body.adapter === "string" && body.adapter ? body.adapter : undefined,
					strict: Boolean(body.strict),
				} as GateParams,
				cwd,
			);
			return { status: 200, body: { message: result.text, details: result.details } };
		}

		return { status: 404, body: { error: `没有这个接口：${req.method} ${req.path}` } };
	} catch (error) {
		return { status: 422, body: { error: (error as Error).message } };
	}
}
