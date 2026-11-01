// Pure unattended policy. The session sends reply exactly once, logs the
// decision, then applies effect; this module never performs I/O or executes tools.
import {
  SERVER_REQUEST,
  POLICY_DECISION,
  POLICY_EFFECT,
  POLICY_TEXT,
  CODEX_ITEM,
} from "../shared/constants.mjs";
import { CODES, RPC_ERROR } from "../shared/errors.mjs";

const result = (value, effect = POLICY_EFFECT.CONTINUE, code = null) => ({
  reply: { result: value },
  effect,
  code,
});
const failure = (rpcCode, message, code) => ({
  reply: { error: { code: rpcCode, message } },
  effect: POLICY_EFFECT.FAIL,
  code,
});

export function answerServerRequest(method) {
  switch (method) {
    case SERVER_REQUEST.COMMAND_APPROVAL:
    case SERVER_REQUEST.FILE_APPROVAL:
      return result({ decision: POLICY_DECISION.DECLINE });
    case SERVER_REQUEST.PERMISSIONS_APPROVAL:
      return result({ permissions: {}, scope: POLICY_DECISION.TURN });
    case SERVER_REQUEST.APPLY_PATCH_APPROVAL:
    case SERVER_REQUEST.EXEC_COMMAND_APPROVAL:
      return result({ decision: { denied: { rejection: POLICY_TEXT.NON_INTERACTIVE } } });
    case SERVER_REQUEST.USER_INPUT:
      return result({ answers: {} }, POLICY_EFFECT.INTERRUPT, CODES.INTERACTION_REQUIRED);
    case SERVER_REQUEST.TOOL_CALL:
      return result({
        success: false,
        contentItems: [{ type: CODEX_ITEM.INPUT_TEXT, text: POLICY_TEXT.NO_TOOLS }],
      });
    case SERVER_REQUEST.MCP_ELICITATION:
      return result({ action: POLICY_DECISION.DECLINE, content: null, _meta: null });
    case SERVER_REQUEST.AUTH_REFRESH:
      return failure(RPC_ERROR.AUTH_REQUIRED, POLICY_TEXT.AUTH_REQUIRED, CODES.CODEX_AUTH_REQUIRED);
    case SERVER_REQUEST.ATTESTATION:
      return failure(
        RPC_ERROR.UNSUPPORTED,
        POLICY_TEXT.ATTESTATION_UNSUPPORTED,
        CODES.CODEX_UNSUPPORTED,
      );
    default:
      return failure(
        RPC_ERROR.METHOD_NOT_FOUND,
        POLICY_TEXT.UNKNOWN_METHOD,
        CODES.CODEX_UNSUPPORTED,
      );
  }
}
