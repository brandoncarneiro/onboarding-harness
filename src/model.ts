import type { AppConfig } from "./config.ts";

export type ModelRole = "system" | "user" | "assistant";

export type ModelMessage = {
  role: ModelRole;
  content: string;
};

export type ReplyMode = "prompt" | "summary" | "saved" | "grounded" | "scripture" | "link";

export type ModelRequest = {
  messages: ModelMessage[];
  safeText: string;
  mode: ReplyMode;
};

export type ModelResult = {
  text: string;
};

export interface LanguageModel {
  complete(request: ModelRequest): Promise<ModelResult>;
}

export class LocalModel implements LanguageModel {
  async complete(request: ModelRequest): Promise<ModelResult> {
    return { text: request.safeText };
  }
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class OpenAiCompatibleModel implements LanguageModel {
  private readonly fetchImpl: FetchLike;
  private readonly options: {
    apiKey: string;
    baseUrl: string;
    model: string;
  };

  constructor(options: {
    apiKey: string;
    baseUrl: string;
    model: string;
    fetchImpl?: FetchLike;
  }) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(request: ModelRequest): Promise<ModelResult> {
    if (!this.options.baseUrl || !this.options.model) {
      throw new Error("MODEL_BASE_URL and MODEL_NAME are required when MODEL_API_KEY is set");
    }
    const base = this.options.baseUrl.replace(/\/$/, "");
    const response = await this.fetchImpl(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.options.apiKey}`,
      },
      body: JSON.stringify({
        model: this.options.model,
        temperature: 0,
        messages: request.messages,
      }),
    });
    if (!response.ok) {
      throw new Error(`model request failed: ${response.status}`);
    }
    const payload = (await response.json()) as {
      choices?: { message?: { content?: unknown } }[];
    };
    const text = payload.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) return { text: request.safeText };
    return { text };
  }
}

export function createModel(config: Pick<AppConfig, "modelApiKey" | "modelBaseUrl" | "modelName">): LanguageModel {
  if (!config.modelApiKey) return new LocalModel();
  if (!config.modelBaseUrl || !config.modelName) {
    throw new Error("MODEL_BASE_URL and MODEL_NAME are required when MODEL_API_KEY is set");
  }
  return new OpenAiCompatibleModel({
    apiKey: config.modelApiKey,
    baseUrl: config.modelBaseUrl,
    model: config.modelName,
  });
}
