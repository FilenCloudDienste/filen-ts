import { type, type Type } from "arktype"
import { kvGetJson, kvSetJson, kvDelete } from "@/lib/storage/adapter"
import { DIRECTORY_NOT_FOUND_PREFIX, type ErrorDTO } from "@/lib/sdk/errors"

// Photos has no per-account prefix — kv is wiped wholesale on logout (kvClear, lib/storage/
// adapter.ts's own doc comment) and no sibling key (drive.sortPreferences.v1, notes.viewMode.v1,
// shell.startScreen.v1) carries an account id either. A fresh login therefore always starts unset.
const PHOTOS_ROOT_KV_KEY = "photos.rootUuid.v1"

const photosRootSchema: Type<string> = type("string")

// null = unset (first visit, or the root was reset after going gone) — the screen's whole state
// machine collapses to this one nullable read: unset renders the hero, non-null renders the ready
// header + listing placeholder.
export async function getPhotosRoot(): Promise<string | null> {
	return await kvGetJson(PHOTOS_ROOT_KV_KEY, photosRootSchema)
}

export async function setPhotosRoot(rootUuid: string): Promise<void> {
	await kvSetJson(PHOTOS_ROOT_KV_KEY, rootUuid)
}

// No kvSetJson(KEY, null) — the schema is a bare string, so a null write would just be dropped as
// invalid on the next read anyway (kvGetJson's own self-heal). kvDelete says what actually happens.
export async function clearPhotosRoot(): Promise<void> {
	await kvDelete(PHOTOS_ROOT_KV_KEY)
}

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
// probe must never wipe a saved root out from under the user.
export function shouldResetRootOnError(dto: ErrorDTO, isOnline: boolean): boolean {
	return isOnline && isRootGoneError(dto)
}
