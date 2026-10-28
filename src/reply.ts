import type { ReplyMode } from "./model.ts";

const FORBIDDEN = /\b(registered|approved|signed[\s-]?up|sign[\s-]?up)\b/i;

export function selectReply(
  mode: ReplyMode,
  safeText: string,
  modelText: string,
): string {
  const safe = safeText.trim();
  const model = modelText.trim();
  if (!model || FORBIDDEN.test(model)) return safe;
  if (mode === "prompt") return safe;
  return model === safe ? model : safe;
}
