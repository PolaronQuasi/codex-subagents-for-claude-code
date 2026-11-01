import assert from "node:assert/strict";
import test from "node:test";
import { answerServerRequest } from "../src/codex/policy.mjs";
import {
  SERVER_REQUEST,
  POLICY_DECISION,
  POLICY_EFFECT,
  POLICY_TEXT,
  CODEX_ITEM,
} from "../src/shared/constants.mjs";
import { CODES, RPC_ERROR } from "../src/shared/errors.mjs";

const responses = new Map([
  [SERVER_REQUEST.COMMAND_APPROVAL, { decision: POLICY_DECISION.DECLINE }],
  [SERVER_REQUEST.FILE_APPROVAL, { decision: POLICY_DECISION.DECLINE }],
  [SERVER_REQUEST.PERMISSIONS_APPROVAL, { permissions: {}, scope: POLICY_DECISION.TURN }],
  [
    SERVER_REQUEST.APPLY_PATCH_APPROVAL,
    { decision: { denied: { rejection: POLICY_TEXT.NON_INTERACTIVE } } },
  ],
  [
    SERVER_REQUEST.EXEC_COMMAND_APPROVAL,
    { decision: { denied: { rejection: POLICY_TEXT.NON_INTERACTIVE } } },
  ],
  [SERVER_REQUEST.USER_INPUT, { answers: {} }],
  [
    SERVER_REQUEST.TOOL_CALL,
    { success: false, contentItems: [{ type: CODEX_ITEM.INPUT_TEXT, text: POLICY_TEXT.NO_TOOLS }] },
  ],
  [SERVER_REQUEST.MCP_ELICITATION, { action: POLICY_DECISION.DECLINE, content: null, _meta: null }],
]);

for (const [method, expected] of responses)
  test(`policy: ${method} never grants interaction or escalation`, () => {
    const answer = answerServerRequest(method, {
      command: "never execute",
      permissions: { network: true },
    });
    assert.deepEqual(answer.reply, { result: expected });
    assert.equal(
      answer.effect,
      method === SERVER_REQUEST.USER_INPUT ? POLICY_EFFECT.INTERRUPT : POLICY_EFFECT.CONTINUE,
    );
    assert.equal(
      answer.code,
      method === SERVER_REQUEST.USER_INPUT ? CODES.INTERACTION_REQUIRED : null,
    );
  });

for (const [method, rpcCode, code, message] of [
  [
    SERVER_REQUEST.AUTH_REFRESH,
    RPC_ERROR.AUTH_REQUIRED,
    CODES.CODEX_AUTH_REQUIRED,
    POLICY_TEXT.AUTH_REQUIRED,
  ],
  [
    SERVER_REQUEST.ATTESTATION,
    RPC_ERROR.UNSUPPORTED,
    CODES.CODEX_UNSUPPORTED,
    POLICY_TEXT.ATTESTATION_UNSUPPORTED,
  ],
  [
    "unknown/futureMethod",
    RPC_ERROR.METHOD_NOT_FOUND,
    CODES.CODEX_UNSUPPORTED,
    POLICY_TEXT.UNKNOWN_METHOD,
  ],
])
  test(`policy: ${method} fails explicitly`, () => {
    assert.deepEqual(answerServerRequest(method), {
      reply: { error: { code: rpcCode, message } },
      effect: POLICY_EFFECT.FAIL,
      code,
    });
  });

test("policy covers exactly ten registered server requests, with fresh answer objects", () => {
  assert.equal(Object.keys(SERVER_REQUEST).length, 10);
  assert.equal(responses.size + 2, Object.keys(SERVER_REQUEST).length);
  answerServerRequest(SERVER_REQUEST.PERMISSIONS_APPROVAL).reply.result.permissions.network = true;
  assert.deepEqual(
    answerServerRequest(SERVER_REQUEST.PERMISSIONS_APPROVAL).reply.result.permissions,
    {},
  );
});
