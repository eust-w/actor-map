/**
 * GitHub PR 交互：拿 diff、去重、贴 review。
 *
 * 只依赖 fetch，不引第三方 SDK —— 门禁工具不该为了发一个评论拖进来一堆依赖。
 * fetch 可以注入，所以整条路径能在没有网络的单测里跑。
 */
import { readFileSync } from "node:fs";
import { VERDICT_MARKER } from "./annotate.js";
const MARKER_RE = /<!--\s*actormap:([^\s]+)\s*-->/g;
export function extractMarkers(body) {
    const found = [];
    MARKER_RE.lastIndex = 0;
    let m = MARKER_RE.exec(body);
    while (m) {
        found.push(m[1]);
        m = MARKER_RE.exec(body);
    }
    return found;
}
function api(target, path) {
    const base = target.apiUrl ?? "https://api.github.com";
    return `${base.replace(/\/$/, "")}${path}`;
}
function headers(target) {
    return {
        Authorization: `Bearer ${target.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "actormap-gate",
        "Content-Type": "application/json",
    };
}
export async function fetchPrFiles(target, fetcher = fetch) {
    const files = [];
    for (let page = 1; page <= 10; page += 1) {
        const res = await fetcher(api(target, `/repos/${target.repo}/pulls/${target.pr}/files?per_page=100&page=${page}`), {
            headers: headers(target),
        });
        if (!res.ok)
            throw new Error(`读取 PR 文件失败：${res.status} ${await safeText(res)}`);
        const batch = (await res.json());
        files.push(...batch);
        if (batch.length < 100)
            break;
    }
    return files;
}
export async function listExisting(target, fetcher = fetch) {
    const markers = new Set();
    const res = await fetcher(api(target, `/repos/${target.repo}/pulls/${target.pr}/comments?per_page=100`), {
        headers: headers(target),
    });
    if (!res.ok)
        throw new Error(`读取 PR 评论失败：${res.status} ${await safeText(res)}`);
    for (const comment of (await res.json())) {
        for (const marker of extractMarkers(comment.body ?? ""))
            markers.add(marker);
    }
    const reviewsRes = await fetcher(api(target, `/repos/${target.repo}/pulls/${target.pr}/reviews?per_page=100`), {
        headers: headers(target),
    });
    let lastVerdictBody;
    let lastVerdictId;
    if (reviewsRes.ok) {
        const reviews = (await reviewsRes.json());
        for (const review of reviews) {
            if ((review.body ?? "").includes(VERDICT_MARKER)) {
                lastVerdictBody = review.body;
                lastVerdictId = review.id;
            }
        }
    }
    return { markers, lastVerdictBody, lastVerdictId };
}
/** 只保留这次还没贴过的注释 */
export function dedupe(payload, existing) {
    return {
        ...payload,
        comments: payload.comments.filter((c) => {
            const marker = extractMarkers(c.body)[0];
            return marker ? !existing.markers.has(marker) : true;
        }),
    };
}
export async function postReview(target, payload, existing, fetcher = fetch) {
    const fresh = dedupe(payload, existing);
    const unchanged = fresh.comments.length === 0 && existing.lastVerdictBody === payload.body;
    if (unchanged) {
        return { posted: false, reason: "与上一次结论完全一致，跳过", comments: 0 };
    }
    const res = await fetcher(api(target, `/repos/${target.repo}/pulls/${target.pr}/reviews`), {
        method: "POST",
        headers: headers(target),
        body: JSON.stringify({
            event: "COMMENT",
            body: payload.body,
            comments: fresh.comments,
        }),
    });
    if (!res.ok)
        throw new Error(`贴 review 失败：${res.status} ${await safeText(res)}`);
    const created = (await res.json());
    return { posted: true, url: created.html_url, comments: fresh.comments.length };
}
async function safeText(res) {
    try {
        return (await res.text()).slice(0, 300);
    }
    catch {
        return "";
    }
}
export function resolveContext(options = {}) {
    const env = options.env ?? process.env;
    const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
    if (!token)
        return { ok: false, reason: "没有 GITHUB_TOKEN，无法贴 PR 评论（Actions 里加 permissions: pull-requests: write）" };
    const repo = env.GITHUB_REPOSITORY;
    if (!repo)
        return { ok: false, reason: "没有 GITHUB_REPOSITORY，不在 GitHub Actions 里" };
    let pr = options.pr;
    if (!pr && env.GITHUB_EVENT_PATH) {
        try {
            const readFile = options.readFile ?? ((p) => readFileSync(p, "utf8"));
            const event = JSON.parse(readFile(env.GITHUB_EVENT_PATH));
            pr = event.pull_request?.number ?? event.issue?.number ?? event.number;
        }
        catch {
            // 落到下面用 GITHUB_REF 兜底
        }
    }
    if (!pr && env.GITHUB_REF) {
        const m = env.GITHUB_REF.match(/refs\/pull\/(\d+)\//);
        if (m)
            pr = Number(m[1]);
    }
    if (!pr)
        return { ok: false, reason: "找不到 PR 编号，用 --pr 指定" };
    return { ok: true, target: { token, repo, pr, apiUrl: env.GITHUB_API_URL } };
}
