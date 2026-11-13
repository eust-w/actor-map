/**
 * 反向建议：代码里有、IR 里没有的那条迁移，应该长成什么样。
 *
 * 只给「可粘贴、可执行」的东西 —— 一段 YAML 和一条命令，不是一段描述。
 * 猜出来的部分（entity / by）必须显式标出来，不让人无声地接受一个假设。
 */

import type { Assertion, IRFile } from "../ir/types.ts";

export interface IrFix {
	entity: string;
	from: string;
	action: string;
	to: string;
	by: string;
	status: "confirmed" | "assumed";
	yaml: string;
	json: string;
	command: string;
	/** 哪些字段是推断出来的 */
	note?: string;
}

function quote(value: string): string {
	return /^[\w\u4e00-\u9fa5./-]+$/.test(value) ? value : JSON.stringify(value);
}

function pickEntity(ir: IRFile, hint: string): { entity: string; guessed: boolean } {
	const names = [...new Set(ir.assertions.map((a) => a.entity))];
	const exact = names.find((n) => n.toLowerCase() === hint.toLowerCase());
	if (exact) return { entity: exact, guessed: false };
	if (names.length === 1) return { entity: names[0], guessed: names[0].toLowerCase() !== hint.toLowerCase() };
	return { entity: names[0] ?? "main", guessed: true };
}

function pickActor(ir: IRFile, hint?: string): { by: string; guessed: boolean } {
	if (hint) {
		const exact = ir.actors.find(
			(a) => a.id.toLowerCase() === hint.toLowerCase() || a.name.toLowerCase() === hint.toLowerCase(),
		);
		if (exact) return { by: exact.id, guessed: false };
	}
	const humans = ir.actors.filter((a) => a.type === "human");
	if (humans.length === 1) return { by: humans[0].id, guessed: true };
	if (ir.actors[0]) return { by: ir.actors[0].id, guessed: true };
	return { by: "app_user", guessed: true };
}

export function buildIrFix(ir: IRFile, a: Assertion): IrFix | undefined {
	if (!a.action || !a.from || !a.to) return undefined;
	const { entity, guessed: entityGuessed } = pickEntity(ir, a.entity);
	const { by, guessed: actorGuessed } = pickActor(ir, a.evidence?.actorHint);
	const status: "confirmed" | "assumed" = actorGuessed || entityGuessed ? "assumed" : "confirmed";
	const source = a.source || `代码：${a.evidence?.file ?? "?"}:${a.evidence?.line ?? "?"}`;

	const assertion = {
		entity,
		from: a.from,
		action: a.action,
		to: a.to,
		by,
		guards: [] as string[],
		verify: "",
		source,
		status,
	};

	const yaml = [
		"- entity: " + quote(entity),
		"  from: " + quote(a.from),
		"  action: " + quote(a.action),
		"  to: " + quote(a.to),
		"  by: " + quote(by),
		"  guards: []",
		'  verify: ""',
		"  source: " + JSON.stringify(source),
		`  status: ${status}`,
	].join("\n");

	const json = JSON.stringify([{ op: "add", assertion }], null, 2);
	const command = [
		'actormap change --file .actormap/drift-fix.json \\',
		`  --reason "补上代码里已有、IR 没确认的迁移：${a.from} --${a.action}--> ${a.to}"`,
	].join("\n");

	const notes: string[] = [];
	if (entityGuessed) notes.push(`entity 推断为 ${entity}`);
	if (actorGuessed) notes.push(`by 推断为 ${by}，请确认发起者`);

	return {
		entity,
		from: a.from,
		action: a.action,
		to: a.to,
		by,
		status,
		yaml,
		json,
		command,
		...(notes.length > 0 ? { note: notes.join("；") } : {}),
	};
}

/** 把一组 fix 合成一份可以直接喂给 `actormap change --file` 的载荷 */
export function mergeFixes(fixes: IrFix[]): string {
	const changes = fixes.flatMap((fix) => JSON.parse(fix.json) as unknown[]);
	return `${JSON.stringify(changes, null, 2)}\n`;
}
