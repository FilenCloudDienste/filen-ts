// The KEEP-vs-DROP decision layer every durable outbox (notes edits, chat sends) applies to a
// rejection the SDK already retried internally. This is NOT the wire retry itself (the SDK owns
// that) — it decides whether a push that already exhausted the SDK's own retries should be
// KEPT-for-retry-forever (offline-safe / recoverable-auth) or counted toward a bounded drop.
//
// Operates on plain strings only: each platform's generated SDK error type stays app-side (mobile's
// numeric uniffi ErrorKind enum, web's wasm ErrorDTO), reduced to a raw `kind: string | undefined` by
// a thin per-platform adapter before it reaches these predicates.
//
// SPELLING GUARD: only the four kind names below are verified identical on both generated SDK
// surfaces — e.g. `Io` (uniffi) vs `IO` (wasm) proves the two enums diverge in casing elsewhere. This
// is a verified-identical-spelling allowlist, never a general kind taxonomy; check both generated
// surfaces before adding to it.

// Wire/transport failures the SDK already retried internally. A push that fails with one of these
// keeps its entry and retries forever (offline-safe).
export const NETWORK_CLASS_ERROR_KINDS: ReadonlySet<string> = new Set(["Reqwest", "RetryFailed", "Response"])

export function isNetworkClassErrorKind(kind: string | undefined): boolean {
	return kind !== undefined && NETWORK_CLASS_ERROR_KINDS.has(kind)
}

// A recoverable authentication state (e.g. right after a password change, before the client
// re-authenticates) rather than a permanent rejection — keep-for-retry, never counts toward the drop.
export function isRetryableAuthErrorKind(kind: string | undefined): boolean {
	return kind === "Unauthenticated"
}

// A genuine read-only/permission rejection must eventually DROP so the wedged consumer (a note's
// content query, a chat's send queue) un-wedges — but a TRANSIENT non-network error (e.g. a one-off
// `Server`, the catch-all for non-`Internal` API failures) must NOT lose the first edit/message. We
// bound the drop: only after this many CONSECUTIVE non-network, non-auth SDK rejections for the same
// item do we discard it.
export const MAX_NON_RETRYABLE_REJECTIONS = 3

// `hasSdkError` is false for a non-SDK throw (e.g. abort, a plain worker Error) — always keep-for-retry,
// never counted toward the drop bound.
export function isPermanentRejection({ hasSdkError, kind }: { hasSdkError: boolean; kind: string | undefined }): boolean {
	return hasSdkError && !isNetworkClassErrorKind(kind) && !isRetryableAuthErrorKind(kind)
}
