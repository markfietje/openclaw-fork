import { QUESTIONS_SCOPE, READ_SCOPE, WRITE_SCOPE, type OperatorScope } from "./operator-scopes.js";

/**
 * Operator scopes granted to a caller that proved possession of the gateway
 * SHARED SECRET (a `token` or `password` credential) and nothing more: no
 * device identity, no paired-device binding, no per-request scope identity.
 *
 * ONE set, EVERY transport. A shared secret must not resolve to more
 * privilege over HTTP than it does over the WebSocket, or the same bearer
 * becomes a different credential depending on the port it speaks to.
 *
 * `operator.admin` is deliberately ABSENT. `authorizeOperatorScopesForMethod`
 * treats it as a universal bypass, so a shared secret carrying it would be a
 * full administrator — `config.set`, `terminal.open`, `secrets.resolve`,
 * `update.run`. `operator.approvals` (resolving an exec escalation) and
 * `operator.talk.secrets` (reading secrets) are absent for the same reason:
 * they are administrative acts, not operator reads.
 *
 * `operator.write` is kept because the OpenAI-compatible HTTP surface
 * (`/v1/chat/completions`, `/v1/responses`, `/v1/embeddings`) authorizes on
 * `chat.send`, which requires it.
 */
export const SHARED_SECRET_OPERATOR_SCOPES: readonly OperatorScope[] = [
  READ_SCOPE,
  WRITE_SCOPE,
  QUESTIONS_SCOPE,
];

/**
 * Scopes that carry administrative authority — the class a shared secret must
 * never resolve to, on any transport. `operator.admin` is a universal bypass
 * in `authorizeOperatorScopesForMethod`, so membership here is equivalent to
 * being an administrator.
 */
export const ADMINISTRATIVE_OPERATOR_SCOPES: readonly OperatorScope[] = ["operator.admin"];
