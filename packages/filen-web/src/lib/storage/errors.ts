// Identifies a boot-time OPFS-open failure across the storage worker boundary. `.name` is the one
// Error field that survives BOTH transports a caller might observe this through — Comlink's own throw
// handler (leader tab, direct wrap) and leader.ts's BroadcastChannel serializeError/deserializeError
// (follower tab) each copy name/message/stack and drop everything else — so identity is checked by
// name, never `instanceof` (a reconstructed error on the other side of either transport is always a
// plain `Error`, never this module's own class).
const OPFS_UNAVAILABLE_NAME = "OpfsUnavailableError"

// Wraps whatever the SAH pool install / OpfsSAHPoolDb open threw (OPFS disabled, private browsing,
// an unsupported browser) into the tagged error db.worker.ts's open() throws in place of the removed
// in-memory fallback.
export function opfsUnavailableError(cause: unknown): Error {
	const message = cause instanceof Error ? cause.message : String(cause)
	const error = new Error(`OPFS unavailable: ${message}`)
	error.name = OPFS_UNAVAILABLE_NAME
	return error
}

export function isOpfsUnavailableError(e: unknown): boolean {
	return e instanceof Error && e.name === OPFS_UNAVAILABLE_NAME
}
