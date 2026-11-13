#!/usr/bin/env node
/**
 * 本地工作台：一个零依赖的 HTTP 服务，前面挂 web/ 里的单页应用。
 *
 *   npm run dev            # http://localhost:4173
 *   npm run dev -- --open  # 顺便开浏览器
 *   PORT=8080 npm run dev
 */

import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { handleApi } from "./app.ts";

const argv = process.argv.slice(2);
const webRoot = resolve(import.meta.dirname, "../../web");
const cwd = resolve(process.env.ACTORMAP_CWD ?? process.cwd());
const port = Number(process.env.PORT ?? 4173);
const host = process.env.HOST ?? "127.0.0.1";

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".json": "application/json; charset=utf-8",
	".ico": "image/x-icon",
};

function readBody(req: import("node:http").IncomingMessage): Promise<unknown> {
	return new Promise((resolveBody, reject) => {
		let raw = "";
		req.on("data", (chunk) => {
			raw += chunk;
			if (raw.length > 1_000_000) {
				reject(new Error("请求体过大"));
				req.destroy();
			}
		});
		req.on("end", () => {
			if (!raw) return resolveBody({});
			try {
				resolveBody(JSON.parse(raw));
			} catch {
				reject(new Error("请求体不是合法 JSON"));
			}
		});
		req.on("error", reject);
	});
}

function serveStatic(pathname: string): { status: number; type: string; body: Buffer | string } | undefined {
	const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
	const target = join(webRoot, normalize(relative));
	if (!target.startsWith(webRoot) || !existsSync(target) || statSync(target).isDirectory()) return undefined;
	return { status: 200, type: MIME[extname(target)] ?? "application/octet-stream", body: readFileSync(target) };
}

export function createAppServer(workdir: string) {
	return createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
	try {
		if (url.pathname.startsWith("/api/")) {
			const body = req.method === "POST" ? await readBody(req) : undefined;
			const result = await handleApi({ method: req.method ?? "GET", path: url.pathname, body }, workdir);
			res.writeHead(result.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
			res.end(JSON.stringify(result.body));
			return;
		}

		const file = serveStatic(url.pathname);
		if (!file) {
			res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
			res.end("404");
			return;
		}
		res.writeHead(file.status, { "content-type": file.type, "cache-control": "no-store" });
		res.end(file.body);
	} catch (error) {
		res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
		res.end(JSON.stringify({ error: (error as Error).message }));
	}
	});
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	const server = createAppServer(cwd);
	server.listen(port, host, () => {
		const url = `http://${host}:${port}`;
		console.log(`ActorMap 工作台已启动：${url}`);
		console.log(`工作目录：${cwd}`);
		console.log(`IR：${join(cwd, ".actormap/ir.json")}`);
		if (argv.includes("--open")) {
			const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
			spawn(opener, [url], { stdio: "ignore", detached: true }).unref();
		}
	});

	server.on("error", (error) => {
		console.error(`启动失败：${(error as Error).message}`);
		process.exit(1);
	});
}
