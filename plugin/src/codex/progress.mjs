// Only explicitly selected completed-item metadata reaches progress storage.
// User/agent messages, tool arguments, command output and reasoning content do not.
import {
  NOTIFICATION,
  CODEX_ITEM,
  PROGRESS_KIND,
  PLAN_STATUS,
  PROGRESS_TEXT_BYTES,
  PROGRESS_MAX_PARTS,
  PROGRESS_REDACTED,
  DIFF_MAX_BYTES,
} from "../shared/constants.mjs";

export { boundedUtf8 } from "../shared/prompt-redactor.mjs";
import { PromptRedactor } from "../shared/prompt-redactor.mjs";

export class ProgressFold {
  constructor(prompt, redactor = new PromptRedactor(PROGRESS_REDACTED)) {
    this.redactor = redactor;
    this.addPrompt(prompt);
  }
  addPrompt(prompt) {
    this.redactor.addPrompt(prompt);
  }
  redact(text, maxBytes) {
    return this.redactor.redact(text, maxBytes);
  }

  text(value) {
    return this.redact(value, PROGRESS_TEXT_BYTES).replace(/[\x00-\x1f\x7f]/g, " ");
  }

  fold(method, params) {
    this.redactor.resetBudget();
    if (method === NOTIFICATION.DIFF_UPDATED && typeof params.diff === "string")
      return { diff: this.redact(params.diff, DIFF_MAX_BYTES) };
    const at = new Date().toISOString();
    if (method === NOTIFICATION.PLAN_UPDATED && Array.isArray(params.plan))
      return {
        entry: {
          kind: PROGRESS_KIND.PLAN,
          at,
          plan: params.plan
            .slice(0, PROGRESS_MAX_PARTS)
            .filter((step) => Object.values(PLAN_STATUS).includes(step?.status))
            .map((step) => ({ step: this.text(step.step), status: step.status })),
        },
      };
    if (method !== NOTIFICATION.ITEM_COMPLETED) return null;
    const item = params.item;
    if (!item) return null;
    const entry = { kind: PROGRESS_KIND.ITEM, at, type: item.type };
    switch (item.type) {
      case CODEX_ITEM.COMMAND:
        Object.assign(entry, {
          command: this.text(item.command),
          exitCode: Number.isInteger(item.exitCode) ? item.exitCode : null,
          durationMs: Number.isFinite(item.durationMs) ? item.durationMs : null,
        });
        break;
      case CODEX_ITEM.FILE_CHANGE:
        entry.paths = (Array.isArray(item.changes) ? item.changes : [])
          .slice(0, PROGRESS_MAX_PARTS)
          .map((change) => this.text(change?.path));
        break;
      case CODEX_ITEM.SEARCH:
        entry.query = this.text(item.query);
        break;
      case CODEX_ITEM.MCP:
        entry.server = this.text(item.server);
        entry.tool = this.text(item.tool);
        break;
      case CODEX_ITEM.REASONING:
        entry.summary = (Array.isArray(item.summary) ? item.summary : [])
          .slice(0, PROGRESS_MAX_PARTS)
          .map((summary) => this.text(summary));
        break;
      default:
        return null;
    }
    return { entry };
  }
}
