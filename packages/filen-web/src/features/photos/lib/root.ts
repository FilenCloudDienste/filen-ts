import { DIRECTORY_NOT_FOUND_PREFIX, type ErrorDTO } from "@/lib/sdk/errors"

// Which listing failures mean a photos root is gone (and is dropped from the library), as opposed to failures
// that leave it alone. The roots themselves: lib/library.ts.

// listDirectory's own thrown message when a browsed uuid no longer resolves (sdk.worker.ts's `kind:
// "uuid"` branch) — a plain Error, never an SDK-kind error (the SDK layer isn't even reached; the
// worker's own cache/getDirOptional resolution fails first), so this is a message-prefix match like
// previewSave.logic.ts's isUnresolvableParentError, not a `dto.kind` check.
export function isRootGoneError(dto: ErrorDTO): boolean {
	return dto.species === "plain" && dto.message.startsWith(DIRECTORY_NOT_FOUND_PREFIX)
}

// Defense-in-depth gate (mirrors the repo-wide rule that a connectivity check belongs at both the
// library and the component layer): even though isRootGoneError already keys off a specific message
// no transient network failure would ever produce, resetting a user's saved root is destructive
// enough to also require the tab believe it's online. A flaky fetch or a cold-start-while-offline
// probe must never drop a saved root out from under the user.
export function shouldResetRootOnError(dto: ErrorDTO, isOnline: boolean): boolean {
	return isOnline && isRootGoneError(dto)
}
