import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReviewPayload } from "../src/gate/annotate.ts";
import { dedupe, extractMarkers, fetchPrFiles, listExisting, postReview, resolveContext } from "../src/gate/github.ts";
import type { Fetcher, GithubTarget } from "../src/gate/github.ts";

const target: GithubTarget = { token: "t", repo: "o/r", pr: 7, apiUrl: "https://api.test" };

interface Call {
	url: string;
	init?: RequestInit;
}

function fakeFetch(handler: (call: Call) => { status?: number; body: unknown }): { fetcher: Fetcher; calls: Call[] } {
	const calls: Call[] = [];
	const fetcher: Fetcher = async (url, init) => {
		calls.push({ url, init });
		const { status = 200, body } = handler({ url, init });
		return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
	};
	return { fetcher, calls };
}

function payload(comments: Array<{ path: string; line: number; marker: string }>): ReviewPayload {
	return {
		body: "<!-- actormap:verdict -->\n结论",
		comments: comments.map((c) => ({
			path: c.path,
			line: c.line,
			side: "RIGHT" as const,
			body: `说明\n\n<!-- actormap:${c.marker} -->`,
		})),
		skipped: [],
	};
}

test("读 PR 文件时分页拼起来", async () => {
	const { fetcher, calls } = fakeFetch(({ url }) => {
		const page = new URL(url).searchParams.get("page");
		return {
			body:
				page === "1"
					? Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}.ts`, patch: "@@ -0,0 +1,1 @@\n+a" }))
					: [{ filename: "last.ts", patch: "@@ -0,0 +1,1 @@\n+b" }],
		};
	});
	const files = await fetchPrFiles(target, fetcher);
	assert.equal(files.length, 101);
	assert.equal(calls.length, 2);
});

test("读已有评论时把标记收齐", async () => {
	const { fetcher } = fakeFetch(({ url }) => {
		if (url.includes("/comments")) {
			return { body: [{ body: "x <!-- actormap:drift:a|b|c -->" }, { body: "无标记" }] };
		}
		return { body: [{ id: 11, body: "<!-- actormap:verdict -->\n旧结论" }] };
	});
	const existing = await listExisting(target, fetcher);
	assert.deepEqual([...existing.markers], ["drift:a|b|c"]);
	assert.equal(existing.lastVerdictId, 11);
	assert.match(existing.lastVerdictBody ?? "", /旧结论/);
});

test("重复的标记不会再贴一次", async () => {
	const { fetcher, calls } = fakeFetch(({ url }) => {
		if (url.includes("/comments")) return { body: [{ body: "<!-- actormap:drift:a|b|c -->" }] };
		if (url.includes("/reviews")) return { body: [] };
		return { body: { html_url: "https://github.test/review/1" } };
	});
	const existing = await listExisting(target, fetcher);
	const result = await postReview(
		target,
		payload([
			{ path: "a.ts", line: 1, marker: "drift:a|b|c" },
			{ path: "a.ts", line: 9, marker: "drift:新的一条" },
		]),
		existing,
		fetcher,
	);
	assert.equal(result.posted, true);
	assert.equal(result.comments, 1);
	const posted = calls.find((c) => c.init?.method === "POST");
	assert.ok(posted);
	const body = JSON.parse(String(posted.init?.body));
	assert.equal(body.comments.length, 1);
	assert.equal(body.comments[0].line, 9);
	assert.equal(body.event, "COMMENT");
});

test("结论没变且没有新标注时不重复刷屏", async () => {
	const { fetcher, calls } = fakeFetch(({ url }) => {
		if (url.includes("/comments")) return { body: [] };
		if (url.includes("/reviews")) return { body: [{ id: 3, body: "<!-- actormark:verdict -->不匹配" }] };
		return { body: {} };
	});
	const existing = await listExisting(target, fetcher);
	const result = await postReview(target, payload([]), { ...existing, lastVerdictBody: "<!-- actormap:verdict -->\n结论" }, fetcher);
	assert.equal(result.posted, false);
	assert.match(result.reason ?? "", /一致/);
	assert.ok(!calls.some((c) => c.init?.method === "POST"));
});

test("dedupe 只保留新标记", () => {
	const fresh = dedupe(payload([{ path: "a", line: 1, marker: "x" }, { path: "a", line: 2, marker: "y" }]), {
		markers: new Set(["x"]),
	});
	assert.equal(fresh.comments.length, 1);
	assert.match(fresh.comments[0].body, /actormap:y/);
});

test("请求头带 token 和版本号", async () => {
	const { fetcher, calls } = fakeFetch(() => ({ body: [] }));
	await fetchPrFiles(target, fetcher);
	const headers = calls[0].init?.headers as Record<string, string>;
	assert.equal(headers.Authorization, "Bearer t");
	assert.equal(headers["X-GitHub-Api-Version"], "2022-11-28");
});

test("从 Actions 环境解析出 PR 编号", () => {
	const event = JSON.stringify({ pull_request: { number: 42 } });
	const result = resolveContext({
		env: {
			GITHUB_TOKEN: "t",
			GITHUB_REPOSITORY: "o/r",
			GITHUB_EVENT_PATH: "/tmp/event.json",
			GITHUB_API_URL: "https://api.test",
		},
		readFile: () => event,
	});
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.target.pr, 42);
	assert.equal(result.target.repo, "o/r");
});

test("没有 token 时说清楚缺什么", () => {
	const result = resolveContext({ env: { GITHUB_REPOSITORY: "o/r" } });
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.match(result.reason, /GITHUB_TOKEN/);
});

test("事件文件读不到时用 GITHUB_REF 兜底", () => {
	const result = resolveContext({
		env: { GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "o/r", GITHUB_REF: "refs/pull/88/merge", GITHUB_EVENT_PATH: "/nope" },
		readFile: () => {
			throw new Error("missing");
		},
	});
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.target.pr, 88);
});

test("标记解析", () => {
	assert.deepEqual(extractMarkers("<!-- actormap:a --> <!-- actormap:b -->"), ["a", "b"]);
	assert.deepEqual(extractMarkers("没有"), []);
});
