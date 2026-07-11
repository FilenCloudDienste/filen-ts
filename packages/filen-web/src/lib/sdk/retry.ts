import { asErrorDTO } from "@/lib/sdk/errors"

// Shared outbox retry classifiers — the KEEP-vs-DROP decision layer every durable outbox (notes edits,
// chat sends) applies to a POST-SDK-retry rejection. These are NOT the wire retry itself (the SDK owns
// that, internally); they decide whether a push that already exhausted the SDK's own retries should be
// KEPT-for-retry-forever (offline-safe) or counted toward a bounded drop. Extracted here verbatim from
// the notes sync so chats reuse the identical semantics instead of re-implementing them — mobile's
// isNetworkClassError/isRetryableAuthError/unwrapSdkError classifiers are shared the same way (a single
// src/lib/sdkErrors module) across its own notes + chats syncs.

// A genuine read-only/permission rejection (a non-network, non-auth SDK error) must eventually DROP so
// the wedged consumer (a note's content query, a chat's send queue) un-wedges — but a TRANSIENT
// non-network error (e.g. a one-off `Server`, the catch-all for non-`Internal` API failures) must NOT
// lose the first edit/message. We bound the drop: only after this many CONSECUTIVE non-network,
// non-auth SDK rejections for the same item do we discard it.
export const MAX_NON_RETRYABLE_REJECTIONS = 3

// The SDK error kinds whose root cause is a wire/transport failure the SDK already retried internally.
// A push that fails with one of these KEEPS its entry and retries forever (offline-safe). Mobile's
// isNetworkClassError over the uniffi ErrorKind enum; mapped here to the web worker's structured-clone-
// safe ErrorDTO `kind` string.
const NETWORK_CLASS_KINDS: ReadonlySet<string> = new Set(["Reqwest", "RetryFailed", "Response"])

export function isNetworkClassError(error: unknown): boolean {
	const dto = asErrorDTO(error)

	return dto.species === "sdk" && dto.kind !== undefined && NETWORK_CLASS_KINDS.has(dto.kind)
}

// An SDK error whose root cause is a recoverable authentication state (`Unauthenticated`, e.g. right
// after a password change, before the client re-authenticates) rather than a permanent rejection.
// Keep-for-retry: the edit/message is valid and succeeds once the session refreshes. Never counts
// toward the drop bound. `kind` is the strongest structured signal the DTO exposes (no permission code).
export function isRetryableAuthError(error: unknown): boolean {
	const dto = asErrorDTO(error)

	return dto.species === "sdk" && dto.kind === "Unauthenticated"
}

// Mobile drops the inflight entry only for a genuine SDK error (`unwrapSdkError` returns non-null); a
// non-SDK throw (`!unwrapped`) is kept-for-retry unconditionally. The web equivalent: a rejection that
// did not cross the SDK worker as an SDK error is species "plain" — treat it as keep-forever, never
// counting it toward the bounded drop.
export function isNonSdkError(error: unknown): boolean {
	return asErrorDTO(error).species !== "sdk"
}
