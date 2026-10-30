import type { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "./config.ts";
import { CheckFailed } from "./errors.ts";
import { replyForSearch } from "./grounding.ts";
import { searchKnowledge } from "./knowledge.ts";
import { issueLinkCode, linkIssuedText, redeemLinkCode } from "./linkCodes.ts";
import type { LanguageModel, ReplyMode } from "./model.ts";
import { MAX_MESSAGE_LENGTH, MESSAGE_TOO_LONG_REPLY } from "./messageLimits.ts";
import type { OutboundMessenger } from "./outbound.ts";
import {
  LINK_FAILED_REPLY,
  LINK_SUCCESS_REPLY,
  SAVED_REPLY,
  SYSTEM_PROMPT,
} from "./prompt.ts";
import { selectReply } from "./reply.ts";
import { ensureSession, persistIntake, readGroup, readSession, type Channel } from "./recordStore.ts";
import type { FieldSpec } from "./schema.ts";
import { scriptureReply } from "./scripture.ts";
import {
  confirmationSummary,
  fieldByLabel,
  fieldPrompt,
  hashValues,
  intakeStatus,
  nextMissing,
  parseFieldInput,
  setPath,
  type DraftValues,
  type IntakeStatus,
} from "./values.ts";

export type AppDeps = {
  db: DatabaseSync;
  config: AppConfig;
  model: LanguageModel;
  fields: FieldSpec[];
  organizationName?: string;
  messenger: OutboundMessenger;
  now: () => number;
};

export type ChatResult = {
  reply: string;
  status: IntakeStatus;
  draft: DraftValues;
  sessionId: string;
};

const CONFIRM = /^yes$/i;
const ISSUE = /^(?:link code|get link code|get a link code)$/i;
const REDEEM = /^(?:use code|code)\s+([A-Za-z0-9]{8})$/i;
const EDIT = /^(?:change|set|update)\s+(.+?)\s+to\s+(.+)$/i;
const QUESTION = /^(what|where|when|who|how|which|does|do|is|are|can)\b/i;

export async function applyIncoming(
  deps: AppDeps,
  input: { channel: Channel; channelKey: string; message: string },
): Promise<ChatResult> {
  return completeIncoming(deps, input.message, prepareIncoming(deps, input));
}

export type PreparedIncoming = { result: ChatResult; mode: ReplyMode };

// All state changes are synchronous so a channel can commit them together with
// its recovery checkpoint, before waiting for optional model phrasing.
export function prepareIncoming(
  deps: AppDeps,
  input: { channel: Channel; channelKey: string; message: string },
): PreparedIncoming {
  const existing = readSession(deps.db, input.channel, input.channelKey);
  const current = existing
    ? readGroup(deps.db, existing.groupId)
    : { id: "", values: {}, pendingHash: null, confirmationHash: null, savedRecordId: null };
  if (input.message.length > MAX_MESSAGE_LENGTH) {
    return { result: result(input.channelKey, MESSAGE_TOO_LONG_REPLY, deps.fields, current), mode: "prompt" };
  }
  const text = input.message.trim();
  const decision = decide(deps, current.values, current.pendingHash, current.confirmationHash, text);

  if (decision.kind === "refuse") {
    return { result: result(input.channelKey, decision.safeText, deps.fields, current), mode: decision.mode };
  }

  const nowMs = deps.now();
  const nowIso = new Date(nowMs).toISOString();
  try {
    if (decision.action === "issue") {
      const code = issueLinkCode(deps.db, { channel: input.channel, channelKey: input.channelKey, nowMs });
      decision.safeText = linkIssuedText(code);
    } else if (decision.action === "redeem") {
      const redeemed = redeemLinkCode(deps.db, {
        channel: input.channel,
        channelKey: input.channelKey,
        code: decision.code,
        nowMs,
      });
      if (!redeemed.linked) {
        return { result: result(input.channelKey, LINK_FAILED_REPLY, deps.fields, current), mode: "link" };
      }
    } else if (decision.action === "touch") {
      ensureSession(deps.db, { channel: input.channel, channelKey: input.channelKey, nowIso });
    } else {
      persistIntake(deps.db, {
        channel: input.channel,
        channelKey: input.channelKey,
        nowIso,
        values: decision.values,
        pendingHash: decision.pendingHash,
        confirmationHash: decision.confirmationHash,
        save: decision.action === "save",
        fields: deps.fields,
      });
    }
  } catch (error) {
    if (!(error instanceof CheckFailed)) throw error;
    return { result: result(input.channelKey, "Those details were not saved.", deps.fields, current), mode: "saved" };
  }

  const session = readSession(deps.db, input.channel, input.channelKey);
  const group = session ? readGroup(deps.db, session.groupId) : current;
  return { result: result(input.channelKey, decision.safeText, deps.fields, group), mode: decision.mode };
}

export async function completeIncoming(deps: AppDeps, message: string, prepared: PreparedIncoming): Promise<ChatResult> {
  if (message.length > MAX_MESSAGE_LENGTH) return prepared.result;
  const reply = await phrase(deps, message.trim(), prepared.result.reply, prepared.mode);
  return { ...prepared.result, reply };
}

type LiveGroup = {
  id: string;
  values: DraftValues;
  pendingHash: string | null;
  confirmationHash: string | null;
  savedRecordId: string | null;
};

type Decision =
  | { kind: "refuse"; safeText: string; mode: ReplyMode }
  | {
      kind: "apply";
      action: "draft" | "save" | "issue" | "redeem" | "touch";
      values: DraftValues;
      pendingHash: string | null;
      confirmationHash: string | null;
      safeText: string;
      mode: ReplyMode;
      code: string;
    };

function decide(
  deps: AppDeps,
  values: DraftValues,
  pendingHash: string | null,
  confirmationHash: string | null,
  text: string,
): Decision {
  if (!text) {
    return { kind: "refuse", safeText: "Enter a message.", mode: "prompt" };
  }
  if (/^(?:\/start|start)$/i.test(text)) {
    const opening = resumePrompt(deps.fields, values, pendingHash, confirmationHash);
    return applyDecision("touch", values, pendingHash, confirmationHash, opening.safeText, opening.mode, "");
  }
  const redeem = REDEEM.exec(text);
  if (redeem?.[1]) {
    return applyDecision("redeem", values, pendingHash, confirmationHash, LINK_SUCCESS_REPLY, "link", redeem[1]);
  }
  if (ISSUE.test(text)) {
    return applyDecision("issue", values, pendingHash, confirmationHash, "", "link", "");
  }
  const edit = EDIT.exec(text);
  if (edit?.[1] && edit[2]) {
    const field = fieldByLabel(deps.fields, edit[1]);
    if (!field) return { kind: "refuse", safeText: "That detail is not in the schema.", mode: "prompt" };
    const parsed = parseFieldInput(field, edit[2]);
    if (!parsed.ok) return { kind: "refuse", safeText: `Enter a valid ${field.title}.`, mode: "prompt" };
    return draftDecision(deps.fields, setPath(values, field.path, parsed.value));
  }
  const scripture = scriptureReply(text);
  if (scripture) {
    return applyDecision("touch", values, pendingHash, confirmationHash, withPrompt(deps.fields, values, scripture), "scripture", "");
  }
  const next = nextMissing(deps.fields, values);
  const confirming = intakeStatus(deps.fields, { values, pendingHash, confirmationHash }) === "awaiting_confirmation";
  if (isQuestion(text) && !(next?.type === "boolean" && CONFIRM.test(text))) {
    const answer = replyForSearch(text, searchKnowledge(deps.db, text));
    return applyDecision("touch", values, pendingHash, confirmationHash, withPrompt(deps.fields, values, answer), "grounded", "");
  }
  if (confirming && CONFIRM.test(text)) {
    const digest = hashValues(deps.fields, values);
    if (pendingHash !== digest) {
      return { kind: "refuse", safeText: "Those details are not confirmed.", mode: "summary" };
    }
    return applyDecision("save", values, digest, digest, SAVED_REPLY, "saved", "");
  }
  if (!next) {
    const summary = confirmationSummary(deps.fields, values);
    const digest = hashValues(deps.fields, values);
    if (pendingHash === digest && confirmationHash === digest) {
      return applyDecision("touch", values, pendingHash, confirmationHash, SAVED_REPLY, "saved", "");
    }
    return applyDecision("draft", values, digest, null, summary, "summary", "");
  }
  const parsed = parseFieldInput(next, text);
  if (!parsed.ok) return { kind: "refuse", safeText: `Enter a valid ${next.title}.`, mode: "prompt" };
  return draftDecision(deps.fields, setPath(values, next.path, parsed.value));
}

function draftDecision(fields: FieldSpec[], values: DraftValues): Decision {
  const missing = nextMissing(fields, values);
  if (missing) {
    return applyDecision("draft", values, null, null, fieldPrompt(missing), "prompt", "");
  }
  return applyDecision("draft", values, hashValues(fields, values), null, confirmationSummary(fields, values), "summary", "");
}

function applyDecision(
  action: "draft" | "save" | "issue" | "redeem" | "touch",
  values: DraftValues,
  pendingHash: string | null,
  confirmationHash: string | null,
  safeText: string,
  mode: ReplyMode,
  code: string,
): Decision {
  return { kind: "apply", action, values, pendingHash, confirmationHash, safeText, mode, code };
}

function resumePrompt(
  fields: FieldSpec[],
  values: DraftValues,
  pendingHash: string | null,
  confirmationHash: string | null,
): { safeText: string; mode: ReplyMode } {
  const status = intakeStatus(fields, { values, pendingHash, confirmationHash });
  if (status === "saved") return { safeText: SAVED_REPLY, mode: "saved" };
  if (status === "awaiting_confirmation") {
    return { safeText: confirmationSummary(fields, values), mode: "summary" };
  }
  const missing = nextMissing(fields, values);
  if (missing) return { safeText: fieldPrompt(missing), mode: "prompt" };
  return { safeText: confirmationSummary(fields, values), mode: "summary" };
}

function withPrompt(fields: FieldSpec[], values: DraftValues, answer: string): string {
  const missing = nextMissing(fields, values);
  if (!missing) return answer;
  return `${answer}\n${fieldPrompt(missing)}`;
}

function isQuestion(text: string): boolean {
  return text.includes("?") || QUESTION.test(text);
}

async function phrase(deps: AppDeps, personMessage: string, safeText: string, mode: ReplyMode): Promise<string> {
  let modelText = safeText;
  try {
    const result = await deps.model.complete({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: personMessage },
      ],
      safeText,
      mode,
    });
    modelText = result.text;
  } catch {
    modelText = safeText;
  }
  return selectReply(mode, safeText, modelText);
}

function result(sessionId: string, reply: string, fields: FieldSpec[], group: LiveGroup): ChatResult {
  return {
    reply,
    status: intakeStatus(fields, group),
    draft: group.values,
    sessionId,
  };
}
