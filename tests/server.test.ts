import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createAppServer } from "../src/server/index.ts";
import { handleApi, snapshot } from "../src/server/app.ts";

function workspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "actormap-web-"));
	mkdirSync(join(dir, ".actormap"), { recursive: true });
	writeFileSync(
		join(dir, ".actormap", "ir.json"),
		`${JSON.stringify(
			{
				product: "报销系统",
				version: 2,
				updatedAt: "",
				actors: [{ id: "employee", name: "员工", type: "human" }],
				assertions: [
					{
						id: "a_001",
						entity: "order",
						from: "∅",
						action: "create",
						to: "draft",
						by: "employee",
						guards: [],
						verify: "",
						source: "员工新建",
						status: "confirmed",
					},
				],
				terminals: [],
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
	return dir;
}

async function call(cwd: string, method: string, path: string, body?: unknown) {
	const res = await handleApi({ method, path, body }, cwd);
	return res;
}

test("GET /api/state 返回完整快照", async () => {
	const dir = workspace();
	try {
		const res = await call(dir, "GET", "/api/state");
		assert.equal(res.status, 200);
		const state = res.body as ReturnType<typeof snapshot>;
		assert.equal(state.product, "报销系统");
		assert.equal(state.assertions.length, 1);
		assert.equal(state.graphs[0].entity, "order");
		assert.ok(Array.isArray(state.issues));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("POST /api/actors 写入后 state 立刻反映", async () => {
	const dir = workspace();
	try {
		const res = await call(dir, "POST", "/api/actors", { id: "manager", name: "主管", type: "human" });
		assert.equal(res.status, 200);
		const body = res.body as { state: ReturnType<typeof snapshot> };
		assert.equal(body.state.actors.length, 2);
		assert.ok(body.state.actors.some((a) => a.id === "manager"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("POST /api/assertions 缺字段时 400", async () => {
	const dir = workspace();
	try {
		const res = await call(dir, "POST", "/api/assertions", { from: "draft" });
		assert.equal(res.status, 400);
		assert.match((res.body as { error: string }).error, /必填/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("未登记的角色被拒，并在错误里列出已有角色", async () => {
	const dir = workspace();
	try {
		const res = await call(dir, "POST", "/api/assertions", {
			from: "draft",
			action: "submit",
			to: "submitted",
			by: "ghost",
		});
		assert.equal(res.status, 422);
		assert.match((res.body as { error: string }).error, /未登记/);
		assert.match((res.body as { error: string }).error, /employee/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("确认终态后，缺口里少一条", async () => {
	const dir = workspace();
	try {
		const before = (await call(dir, "POST", "/api/assertions", {
			from: "draft",
			action: "submit",
			to: "submitted",
			by: "employee",
			source: "提交",
		})) as { body: { state: ReturnType<typeof snapshot> } };
		const terminalGap = before.body.state.issues.filter((i) => i.code === "unconfirmed_terminal");
		assert.ok(terminalGap.some((i) => i.refs.includes("submitted")));

		const res = await call(dir, "POST", "/api/terminals", { state: "submitted" });
		assert.equal(res.status, 200);
		const after = (res.body as { state: ReturnType<typeof snapshot> }).state;
		assert.ok(!after.issues.some((i) => i.code === "unconfirmed_terminal" && i.refs.includes("submitted")));
		assert.ok(after.issues.length < before.body.state.issues.length, "确认终态后缺口总数应当减少");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("未知接口 404", async () => {
	const dir = workspace();
	try {
		const res = await call(dir, "GET", "/api/nope");
		assert.equal(res.status, 404);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("真的起一个 HTTP 服务，前端能拿到页面和 JSON", async () => {
	const dir = workspace();
	const server = createAppServer(dir);
	try {
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		const base = `http://127.0.0.1:${port}`;

		const page = await fetch(`${base}/`);
		assert.equal(page.status, 200);
		assert.match(page.headers.get("content-type") ?? "", /text\/html/);
		assert.match(await page.text(), /ActorMap/);

		const script = await fetch(`${base}/app.js`);
		assert.equal(script.status, 200);
		assert.match(script.headers.get("content-type") ?? "", /javascript/);

		const state = await fetch(`${base}/api/state`);
		const json = (await state.json()) as ReturnType<typeof snapshot>;
		assert.equal(json.product, "报销系统");

		const post = await fetch(`${base}/api/actors`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: "finance", name: "财务", type: "human" }),
		});
		assert.equal(post.status, 200);
		assert.equal(((await post.json()) as { state: ReturnType<typeof snapshot> }).state.actors.length, 2);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(dir, { recursive: true, force: true });
	}
});
