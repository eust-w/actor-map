/**
 * 最小 LLM 客户端：只发一次请求，不流式、不重试。
 *
 * 走 Gemini 的 REST 形状（generateContent），因为绝大多数代理网关都兼容它；
 * 配置全部来自环境变量，所以既能用官方 key，也能指向本地代理或自建网关。
 */

export interface LlmConfig {
	base: string;
	key: string;
	model: string;
}

export interface FunctionCall {
	name: string;
	args: Record<string, unknown>;
}

export interface LlmReply {
	text: string;
	calls: FunctionCall[];
}

export interface Content {
	role: "user" | "model";
	parts: unknown[];
}

export interface GenerateInput {
	system: string;
	contents: Content[];
	tools?: unknown[];
}

export type Generate = (input: GenerateInput) => Promise<LlmReply>;

export function resolveLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig | undefined {
	const base = env.ACTORMAP_LLM_BASE ?? env.GOOGLE_GEMINI_BASE_URL;
	const key = env.ACTORMAP_LLM_KEY ?? env.GEMINI_API_KEY;
	const model = env.ACTORMAP_LLM_MODEL ?? env.GEMINI_MODEL ?? "gemini-2.5-flash";
	if (!base || !key) return undefined;
	return { base: base.replace(/\/$/, ""), key, model };
}

/** 去掉 thought 类型的 part：代理返回的思考内容不该进对话历史 */
function visibleParts(parts: Array<Record<string, unknown>> | undefined): {
	text: string;
	calls: FunctionCall[];
} {
	let text = "";
	const calls: FunctionCall[] = [];
	for (const part of parts ?? []) {
		if (part.thought) continue;
		if (typeof part.text === "string") text += part.text;
		const call = part.functionCall as { name?: string; args?: Record<string, unknown> } | undefined;
		if (call?.name) calls.push({ name: call.name, args: call.args ?? {} });
	}
	return { text: text.trim(), calls };
}

export function createGenerate(config: LlmConfig, fetcher: typeof fetch = fetch): Generate {
	return async ({ system, contents, tools }) => {
		const body: Record<string, unknown> = {
			systemInstruction: { parts: [{ text: system }] },
			contents,
			generationConfig: { temperature: 0.4, maxOutputTokens: 1200 },
		};
		// Gemini 要求工具声明包一层 functionDeclarations
		if (tools && tools.length > 0) body.tools = [{ functionDeclarations: tools }];

		const res = await fetcher(`${config.base}/v1beta/models/${config.model}:generateContent`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-goog-api-key": config.key },
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			const detail = (await res.text()).slice(0, 300);
			throw new Error(`模型调用失败 ${res.status}：${detail}`);
		}
		const json = (await res.json()) as {
			candidates?: Array<{ content?: { parts?: Array<Record<string, unknown>> } }>;
		};
		return visibleParts(json.candidates?.[0]?.content?.parts);
	};
}
