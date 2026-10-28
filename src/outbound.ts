import type { AppConfig } from "./config.ts";

export interface OutboundMessenger {
  send(chatId: string, text: string): Promise<void>;
}

export class NoopMessenger implements OutboundMessenger {
  async send(): Promise<void> {}
}

export class TelegramBotMessenger implements OutboundMessenger {
  private readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  async send(chatId: string, text: string): Promise<void> {
    const response = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!response.ok) throw new Error(`telegram send failed: ${response.status}`);
  }
}

export function createMessenger(config: Pick<AppConfig, "telegramBotToken">): OutboundMessenger {
  if (!config.telegramBotToken) return new NoopMessenger();
  return new TelegramBotMessenger(config.telegramBotToken);
}
