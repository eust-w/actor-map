/**
 * IR 的读写。纯文件，进 git，可 diff —— 这是整个项目能做增量变更的前提。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Actor, Assertion, IRFile } from "./types.ts";
import { EMPTY_ALIASES, EMPTY_STATE, emptyIR } from "./types.ts";

export const DEFAULT_IR_PATH = join(".actormap", "ir.json");

export function resolveIRPath(cwd: string, custom?: string): string {
	return resolve(cwd, custom ?? process.env.ACTORMAP_IR ?? DEFAULT_IR_PATH);
}

export function loadIR(path: string, product = "未命名产品"): IRFile {
	if (!existsSync(path)) return emptyIR(product);
	const raw = readFileSync(path, "utf8");
	const parsed = JSON.parse(raw) as Partial<IRFile>;
	return {
		product: parsed.product ?? product,
		version: parsed.version ?? 0,
		updatedAt: parsed.updatedAt ?? new Date().toISOString(),
		actors: parsed.actors ?? [],
		assertions: parsed.assertions ?? [],
		terminals: parsed.terminals ?? [],
		changesets: parsed.changesets ?? [],
		tombstones: parsed.tombstones ?? [],
	};
}

export function saveIR(path: string, ir: IRFile): void {
	mkdirSync(dirname(path), { recursive: true });
	ir.updatedAt = new Date().toISOString();
	writeFileSync(path, `${JSON.stringify(ir, null, 2)}\n`, "utf8");
}

function nextId(ir: IRFile, prefix: string): string {
	let max = 0;
	for (const item of [...ir.actors.map((a) => a.id), ...ir.assertions.map((a) => a.id)]) {
		const m = item.match(new RegExp(`^${prefix}_(\\d+)$`));
		if (m) max = Math.max(max, Number(m[1]));
	}
	return `${prefix}_${String(max + 1).padStart(3, "0")}`;
}

export interface AddActorInput {
	id?: string;
	name: string;
	type: Actor["type"];
	trigger?: string;
	note?: string;
}

export function addActor(ir: IRFile, input: AddActorInput): Actor {
	const id = (input.id?.trim() || slug(input.name)) as string;
	const existing = ir.actors.find((a) => a.id === id);
	if (existing) {
		existing.name = input.name;
		existing.type = input.type;
		if (input.trigger) existing.trigger = input.trigger;
		if (input.note) existing.note = input.note;
		return existing;
	}
	const actor: Actor = {
		id,
		name: input.name,
		type: input.type,
		...(input.trigger ? { trigger: input.trigger } : {}),
		...(input.note ? { note: input.note } : {}),
	};
	ir.actors.push(actor);
	return actor;
}

export interface AddAssertionInput {
	entity?: string;
	from: string;
	action: string;
	to: string;
	by: string;
	guards?: string[];
	verify?: string;
	source?: string;
	status?: Assertion["status"];
}

export type AddAssertionResult =
	| { ok: true; assertion: Assertion; warnings: string[] }
	| { ok: false; error: string };

export function addAssertion(ir: IRFile, input: AddAssertionInput): AddAssertionResult {
	const by = input.by.trim();
	if (!ir.actors.some((a) => a.id === by)) {
		const known = ir.actors.map((a) => `${a.id}(${a.name})`).join(", ") || "（还没有登记任何 actor）";
		return { ok: false, error: `actor "${by}" 未登记。已登记：${known}。请先调用 ir_add_actor。` };
	}
	const entity = (input.entity?.trim() || "main").trim();
	const from = normalizeState(input.from);
	const to = normalizeState(input.to);
	const guarded = (input.guards ?? []).map((g) => g.trim()).filter(Boolean);
	const duplicate = ir.assertions.find(
		(a) => a.entity === entity && a.from === from && a.action === input.action.trim(),
	);
	if (duplicate) {
		return {
			ok: false,
			error: `(${entity}, ${from}, ${input.action}) 已有断言 ${duplicate.id}，指向 ${duplicate.to}。同一状态下同一动作只能有一个结果，否则产品行为不确定。若确要更改，请说明"改哪条"。`,
		};
	}
	const warningList: string[] = [];
	const source = (input.source ?? "").trim();
	if (!source) warningList.push("没有原话依据（source），这条会被标为 ⚠ 待确认。");

	const assertion: Assertion = {
		id: nextId(ir, "a"),
		entity,
		from,
		action: input.action.trim(),
		to,
		by,
		guards: guarded,
		verify: (input.verify ?? "").trim(),
		source,
		status: input.status ?? (source ? "confirmed" : "assumed"),
	};
	ir.assertions.push(assertion);
	return { ok: true, assertion, warnings: warningList };
}

export function acknowledgeTerminals(ir: IRFile, keys: string[]): string[] {
	const added: string[] = [];
	for (const raw of keys) {
		const key = raw.trim();
		if (!key || ir.terminals.includes(key)) continue;
		ir.terminals.push(key);
		added.push(key);
	}
	return added;
}

function normalizeState(state: string): string {
	const trimmed = (state ?? "").trim();
	return EMPTY_ALIASES.has(trimmed.toLowerCase()) ? EMPTY_STATE : trimmed;
}

export function bumpVersion(ir: IRFile): number {
	ir.version += 1;
	return ir.version;
}

function slug(text: string): string {
	return (
		text
			.toLowerCase()
			.replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "_")
			.replace(/^_+|_+$/g, "") || "actor"
	);
}
