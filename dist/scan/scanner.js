/**
 * 仓库扫描：从代码里抽出「可确认的骨架」，而不是生成一张可信的地图。
 *
 * 原则：没有证据（file:line）的结论不进图，只能变成问题。
 * 这样扫描的产出永远是「70% 对的骨架 + 一段追问清单」，冷启动从"从零讲一遍"变成"挑错"。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { emptyIR } from "../ir/types.js";
const IGNORED_DIRS = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".venv",
    "venv",
    "vendor",
    "target",
    "__pycache__",
    "coverage",
    ".idea",
    ".vscode",
    "migrations",
    ".actormap",
    ".actormap-tool",
    // 测试里的状态赋值是造数据，不是产品行为。不排除的话门禁天天误报。
    "tests",
    "test",
    "__tests__",
    "spec",
    "specs",
    "fixtures",
    "e2e",
]);
/** 文件名层面的排除：xxx.test.ts / xxx.spec.ts / xxx.stories.ts */
const TEST_FILE = /\.(test|spec|stories|stub|mock)\.[cm]?[jt]sx?$/i;
const CODE_EXTS = new Set([
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".py",
    ".rb",
    ".java",
    ".kt",
    ".go",
    ".php",
    ".cs",
    ".rs",
    ".sql",
    ".prisma",
]);
const MAX_FILES = 4000;
const MAX_BYTES = 512 * 1024;
function walk(root, limit = MAX_FILES) {
    const out = [];
    const stack = [root];
    while (stack.length > 0 && out.length < limit) {
        const dir = stack.pop();
        let entries;
        try {
            entries = readdirSync(dir);
        }
        catch {
            continue;
        }
        for (const name of entries) {
            if (name.startsWith(".") && name !== ".") {
                if (IGNORED_DIRS.has(name))
                    continue;
            }
            const full = join(dir, name);
            let info;
            try {
                info = statSync(full);
            }
            catch {
                continue;
            }
            if (info.isDirectory()) {
                if (IGNORED_DIRS.has(name))
                    continue;
                stack.push(full);
            }
            else if (CODE_EXTS.has(extname(name).toLowerCase()) && !TEST_FILE.test(name)) {
                out.push(full);
                if (out.length >= limit)
                    break;
            }
        }
    }
    return out;
}
// ── 各类模式 ────────────────────────────────────────────────────────────
const ENTITY_PATTERNS = [
    { re: /^\s*model\s+([A-Z]\w*)\s*\{/, name: 1 },
    { re: /^\s*class\s+([A-Z]\w*)\s*\(\s*(?:models\.Model|BaseModel|Base)\s*\)/, name: 1 },
    { re: /@(?:Entity|Table|Document)[^\n]*\n(?:[\s\S]{0,200}?)class\s+([A-Z]\w*)/, name: 1 },
    { re: /CREATE\s+TABLE\s+["`]?(\w+)/i, name: 1 },
];
/** TS 的 interface 只有出现在模型目录、或带 status/state 字段时，才算实体 */
const TS_ENTITY = /^\s*export\s+(?:interface|type)\s+([A-Z]\w*)\s*(?:=|\{)/;
const STATE_ENUM_PATTERNS = [
    /(?:enum|type)\s+(\w*(?:Status|State)\w*)\s*(?:=\s*)?\{([^}]+)\}/i,
    /(\w*(?:STATUS|STATE)\w*)\s*[:=]\s*\{([^}]+)\}/,
    /class\s+(\w*(?:Status|State)\w*)\s*\(\s*(?:str,\s*)?Enum\s*\)\s*:\s*([\s\S]{0,400})/,
];
/** 状态赋值：`x.status = "paid"` / `status: "paid"` / `setStatus("paid")` */
const ASSIGN_PATTERNS = [
    { re: /\.(?:status|state)\s*=\s*["'`]([\w-]+)["'`]/i, name: 1 },
    { re: /\b(?:status|state)\s*:\s*["'`]([\w-]+)["'`]/i, name: 1 },
    { re: /set[A-Z]?\w*Status\(\s*["'`]([\w-]+)["'`]\s*\)/, name: 1 },
    { re: /UPDATE\s+\w+\s+SET\s+(?:status|state)\s*=\s*['"]([\w-]+)['"]/i, name: 1 },
];
const GUARD_PATTERNS = [
    /\.(?:status|state)\s*===?\s*["'`]([\w-]+)["'`]/i,
    /\.(?:status|state)\s*!==?\s*["'`]([\w-]+)["'`]/i,
];
const ROUTE_PATTERNS = [
    { re: /\b(?:router|app)\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/i, method: 1, name: 2 },
    { re: /@(Get|Post|Put|Patch|Delete)Mapping\(\s*["'`]([^"'`]+)["'`]/, method: 1, name: 2 },
    { re: /@(?:app|router)\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/i, method: 1, name: 2 },
    { re: /\bdef\s+(\w+)\s*\([^)]*\)\s*:\s*#\s*(?:GET|POST|PUT|PATCH|DELETE)\s+(\S+)/, name: 1 },
];
const FUNC_PATTERNS = [
    /\b(?:async\s+)?function\s+(\w+)/,
    /\bconst\s+(\w+)\s*=\s*(?:async\s*)?\(/,
    /^\s*(?:public|private|protected)?\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*\w+)?\s*\{/,
    /^\s*def\s+(\w+)/,
];
const ACTOR_PATTERNS = [
    /\brole\s*===?\s*["'`]([\w-]+)["'`]/gi,
    /\brole\s*:\s*["'`]([\w-]+)["'`]/gi,
    /hasRole\(\s*["'`]([\w-]+)["'`]\s*\)/gi,
    /@(?:Roles|PreAuthorize|requires_role|roles)\(([^)]*)\)/gi,
    /\b(?:roles?|permissions?)\s*:\s*\[([^\]]*)\]/gi,
];
const SYSTEM_PATTERNS = [
    { re: /\bcron\.schedule\s*\(/, kind: "system" },
    { re: /@Scheduled\s*\(/, kind: "system" },
    { re: /\bschedule\.every\s*\(/, kind: "system" },
    { re: /setInterval\s*\(/, kind: "system" },
    { re: /["'`][^"'`]*(?:webhook|callback)[^"'`]*["'`]/i, kind: "system" },
];
function snippet(line) {
    return line.trim().slice(0, 160);
}
function parseEnumMembers(body) {
    return body
        .split(/[,\n]/)
        .map((part) => part.replace(/\/\/.*$/, "").trim())
        .filter(Boolean)
        .map((part) => {
        const kv = part.match(/=\s*["'`]([\w-]+)["'`]/);
        if (kv)
            return kv[1];
        const key = part.match(/^["'`]?([\w-]+)["'`]?/);
        return key ? key[1] : "";
    })
        .filter((v) => v && v.length < 40);
}
function camelToWords(name) {
    return name
        .replace(/[_-]+/g, " ")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .trim();
}
function entityFromPath(path) {
    const file = basename(path).replace(/\.\w+$/, "");
    const cleaned = file.replace(/(\.|-|_)?(service|controller|handler|route|routes|api|model|entity|schema|resolver|usecase|use-case)$/i, "");
    const base = cleaned.split(/[.\-_]/)[0];
    if (!base || base.length < 3)
        return undefined;
    return base.charAt(0).toUpperCase() + base.slice(1);
}
export function scanRepo(root) {
    const files = walk(root);
    const findings = [];
    const questions = [];
    const warnings = [];
    const entities = new Map();
    const states = new Map();
    const transitions = [];
    const actors = new Map();
    const systems = new Map();
    for (const file of files) {
        let text;
        try {
            if (statSync(file).size > MAX_BYTES)
                continue;
            text = readFileSync(file, "utf8");
        }
        catch {
            continue;
        }
        const rel = relative(root, file);
        const lines = text.split(/\r?\n/);
        const entityGuess = entityFromPath(rel);
        let currentAction;
        let currentRoute;
        // 只在能确定「完整语句块」时才记 range：删半截代码比不删更糟
        let block;
        let blockActor;
        let inBlock = false;
        let depth = 0;
        let opened = false;
        for (let i = 0; i < lines.length; i += 1) {
            const line = lines[i];
            const evidence = { file: rel, line: i + 1, snippet: snippet(line) };
            const isComment = /^\s*(?:\/\/|\/\*|\*|#(?!\s*\w+\s*[:=]))/.test(line);
            if (isComment)
                continue;
            // 实体
            for (const pattern of ENTITY_PATTERNS) {
                const m = line.match(pattern.re);
                if (m) {
                    const name = m[pattern.name];
                    if (name && !entities.has(name)) {
                        entities.set(name, evidence);
                        findings.push({ kind: "entity", confidence: "high", value: name, evidence });
                    }
                }
            }
            const tsEntity = line.match(TS_ENTITY);
            if (tsEntity) {
                const name = tsEntity[1];
                const body = lines.slice(i, i + 30).join("\n");
                const looksLikeModel = /(model|models|entity|entities|domain|aggregate|schema)/i.test(rel);
                const hasStateField = /^\s*(?:readonly\s+)?(?:status|state)\s*\??\s*:/m.test(body);
                if ((looksLikeModel || hasStateField) && !entities.has(name)) {
                    entities.set(name, evidence);
                    findings.push({ kind: "entity", confidence: looksLikeModel ? "high" : "medium", value: name, evidence });
                }
            }
            // 状态枚举（可能跨多行，用小窗口拼一下）
            for (const pattern of STATE_ENUM_PATTERNS) {
                const window = lines.slice(i, i + 12).join("\n");
                const m = window.match(pattern);
                if (m) {
                    const enumName = m[1];
                    const values = parseEnumMembers(m[2] ?? "");
                    for (const value of values) {
                        const key = value.toLowerCase();
                        if (!states.has(key)) {
                            states.set(key, { value, evidence, enumName });
                            findings.push({ kind: "state", confidence: "high", value, evidence });
                        }
                    }
                }
            }
            // 路由 / 函数名 → 动作名
            for (const pattern of ROUTE_PATTERNS) {
                const m = line.match(pattern.re);
                if (m) {
                    block = { start: i };
                    blockActor = undefined;
                    inBlock = true;
                    depth = 0;
                    opened = false;
                    const path = m[pattern.name];
                    const method = pattern.method ? m[pattern.method] : "CALL";
                    currentRoute = { method: method.toUpperCase(), path };
                    const seg = path.split("/").filter(Boolean).pop();
                    currentAction = seg ? seg.replace(/[:{}]/g, "") : undefined;
                    break;
                }
            }
            if (!currentAction) {
                for (const pattern of FUNC_PATTERNS) {
                    const m = line.match(pattern);
                    if (m) {
                        currentAction = m[1];
                        break;
                    }
                }
            }
            // 状态迁移
            for (const pattern of ASSIGN_PATTERNS) {
                const m = line.match(pattern.re);
                if (!m)
                    continue;
                const to = m[pattern.name];
                if (!to)
                    continue;
                // 往上找最近的状态比较，作为 from 的猜测
                let from;
                for (let j = i; j >= Math.max(0, i - 25); j -= 1) {
                    for (const gp of GUARD_PATTERNS) {
                        const g = lines[j].match(gp);
                        if (g && g[1] !== to) {
                            from = g[1];
                            break;
                        }
                    }
                    if (from)
                        break;
                }
                const action = currentAction ?? currentRoute?.path ?? "unknown";
                transitions.push({
                    from,
                    to,
                    actor: "?", // 稍后从上下文补
                    action,
                    evidence,
                    entity: entityGuess ?? "main",
                    block,
                    actorHint: blockActor,
                });
                break;
            }
            // 角色
            for (const pattern of ACTOR_PATTERNS) {
                pattern.lastIndex = 0;
                let m = pattern.exec(line);
                while (m) {
                    const raw = m[1];
                    for (const token of raw.split(/[,\s|]+/)) {
                        const role = token.replace(/["'`[\]]/g, "").trim();
                        if (!role || role.length > 30)
                            continue;
                        if (/^(true|false|null|undefined|role|roles|permissions)$/i.test(role))
                            continue;
                        if (!blockActor)
                            blockActor = role;
                        if (!actors.has(role)) {
                            actors.set(role, evidence);
                            findings.push({ kind: "actor", confidence: "medium", value: role, evidence });
                        }
                    }
                    m = pattern.exec(line);
                }
            }
            // 维护当前语句块的括号深度，闭合时记下结束行
            if (inBlock) {
                for (const ch of line) {
                    if (ch === "{") {
                        depth += 1;
                        opened = true;
                    }
                    else if (ch === "}") {
                        depth -= 1;
                    }
                }
                if (opened && depth <= 0) {
                    if (block)
                        block.end = i;
                    inBlock = false;
                    block = undefined;
                }
            }
            // 系统 / 外部触发
            for (const pattern of SYSTEM_PATTERNS) {
                if (!pattern.re.test(line))
                    continue;
                const key = currentRoute?.path ?? currentAction ?? basename(rel);
                if (!systems.has(key)) {
                    systems.set(key, evidence);
                    findings.push({ kind: "system", confidence: "medium", value: key, evidence });
                }
            }
        }
    }
    // ── 组装骨架 ──────────────────────────────────────────────────────
    const skeleton = emptyIR(basename(root) || "扫描结果");
    const roles = [...actors.keys()];
    if (roles.length === 0) {
        skeleton.actors.push({ id: "app_user", name: "使用者", type: "human", note: "扫描未发现角色定义，先放一个占位" });
        warnings.push("没有在代码里找到任何角色/权限定义，已放一个占位 actor。");
    }
    else {
        for (const role of roles.slice(0, 24)) {
            skeleton.actors.push({ id: normalizeId(role), name: role, type: "human" });
        }
    }
    for (const [key, evidence] of systems) {
        if (skeleton.actors.length > 60)
            break;
        const isWebhook = /webhook|callback/i.test(key);
        skeleton.actors.push({
            id: normalizeId(`${isWebhook ? "ext" : "sys"}_${key}`),
            name: isWebhook ? `外部回调：${key}` : `系统任务：${key}`,
            type: isWebhook ? "external" : "system",
            trigger: isWebhook ? "外部事件推送" : "定时或后台触发",
            note: `${evidence.file}:${evidence.line}`,
        });
    }
    // 一个块里只有一条迁移时才给 range：否则删整块会误伤别的行为
    const blockCount = new Map();
    for (const t of transitions) {
        if (!t.block)
            continue;
        blockCount.set(t.block, (blockCount.get(t.block) ?? 0) + 1);
    }
    const defaultActor = skeleton.actors[0]?.id ?? "app_user";
    const seen = new Set();
    let used = 0;
    for (const t of transitions) {
        if (used >= 80)
            break;
        if (!t.to)
            continue;
        const from = t.from ?? "∅";
        const key = `${t.entity}|${from}|${t.action}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        const assertion = {
            id: `a_${String(used + 1).padStart(3, "0")}`,
            entity: t.entity,
            from,
            action: t.action,
            to: t.to,
            by: defaultActor,
            guards: [],
            verify: "",
            source: `代码：${t.evidence.file}:${t.evidence.line}`,
            status: t.from ? "confirmed" : "assumed",
            evidence: {
                file: t.evidence.file,
                line: t.evidence.line,
                ...(t.block?.end !== undefined && blockCount.get(t.block) === 1
                    ? { startLine: t.block.start + 1, endLine: t.block.end + 1 }
                    : {}),
                ...(t.actorHint ? { actorHint: t.actorHint } : {}),
            },
        };
        skeleton.assertions.push(assertion);
        used += 1;
        if (!t.from) {
            questions.push(`${t.evidence.file}:${t.evidence.line} 把状态改成 "${t.to}"，但看不出是从哪个状态来的。它前面一定是哪个状态？`);
        }
    }
    skeleton.version = 1;
    if (skeleton.assertions.length === 0) {
        warnings.push("没有找到任何状态赋值。可能是前端渲染型项目、低代码平台，或者状态字段不叫 status/state。");
    }
    if (entities.size === 0) {
        warnings.push("没有识别到数据模型，所有迁移都会挂在 entity=main 上。");
    }
    questions.push(...[...states.values()]
        .filter((s) => !transitions.some((t) => t.to === s.value || t.from === s.value))
        .slice(0, 10)
        .map((s) => `状态 "${s.value}"（${s.evidence.file}:${s.evidence.line}）在代码里没有任何迁移。它是终态，还是这次没扫到？`));
    return {
        root,
        filesScanned: files.length,
        findings,
        skeleton,
        questions: [...new Set(questions)].slice(0, 30),
        warnings,
    };
}
function normalizeId(text) {
    return (text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 40) || "actor");
}
export function formatScanReport(report) {
    const lines = [];
    const byKind = new Map();
    for (const f of report.findings)
        byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1);
    const summary = [...byKind].map(([k, n]) => `${k} ${n}`).join(" · ");
    lines.push(`扫描 ${report.root}：${report.filesScanned} 个文件 → ${summary || "无发现"}`);
    lines.push(`骨架：${report.skeleton.actors.length} 个角色 · ${report.skeleton.assertions.length} 条迁移（高置信 ${report.skeleton.assertions.filter((a) => a.status === "confirmed").length} / 待确认 ${report.skeleton.assertions.filter((a) => a.status === "assumed").length}）`);
    for (const w of report.warnings)
        lines.push(`⚠ ${w}`);
    if (report.questions.length > 0) {
        lines.push("", "需要人回答的问题：");
        for (const q of report.questions.slice(0, 12))
            lines.push(`  · ${q}`);
        if (report.questions.length > 12)
            lines.push(`  … 还有 ${report.questions.length - 12} 条`);
    }
    return lines.join("\n");
}
