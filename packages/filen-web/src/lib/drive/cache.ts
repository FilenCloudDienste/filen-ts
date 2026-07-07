// Whole-statement `import type` (not the usual inline `type` keyword — see queries/drive.ts): the
// inline form doesn't reliably elide under vitest for this package, and a non-elided import drags
// in the wasm-bindgen worker glue (references `self`, undefined under Node).
import type { Dir } from "@filen/sdk-rs"

// In-memory only — persistence is deferred. Imported into sdk.worker.ts (the only place that calls
// listDir/createDir/getDirOptional), so population and cache-first reads live right next to the SDK
// calls they save: every listing and every directory create populates it; listDirectory/
// createDirectory/resolveDirectoryNames consult it before any getDirOptional round trip
// (cache-first — getDirOptional only on a cold miss, e.g. a deep-linked uuid this tab has never
// listed). Cleared on every new client adoption (see sdk.worker.ts's adoptClient) so a fresh session
// never sees a prior account's directories.
const dirsByUuid = new Map<string, Dir>()
const namesByUuid = new Map<string, string>()

function extractName(dir: Dir): string | undefined {
	return dir.meta.type === "decoded" ? dir.meta.data.name : undefined
}

export function getCachedDir(uuid: string): Dir | undefined {
	return dirsByUuid.get(uuid)
}

export function getCachedName(uuid: string): string | undefined {
	return namesByUuid.get(uuid)
}

// Upserts every dir into both maps — the single population point for listDirectory's returned
// dirs, createDirectory's created-or-idempotent-existing dir, and resolveDirectoryNames' cold
// getDirOptional fallback. A dir whose meta isn't decodable updates the Dir map only; any name
// cached for it earlier is left in place rather than clobbered with nothing — the name can only
// become stale if decryption itself regresses mid-session, and a stale-but-real name is a better
// fallback than reverting the UI to a raw uuid.
export function cacheDirs(dirs: readonly Dir[]): void {
	for (const dir of dirs) {
		dirsByUuid.set(dir.uuid, dir)

		const name = extractName(dir)
		if (name !== undefined) {
			namesByUuid.set(dir.uuid, name)
		}
	}
}

export function clearDirectoryCache(): void {
	dirsByUuid.clear()
	namesByUuid.clear()
}

// Removes a batch of uuids from both maps — the delete-side counterpart to cacheDirs. Exported for
// whichever action call site needs to invalidate a directory this session already cached (e.g. a
// permanent delete), so a later cache-first read (createDirectory's parent resolve, a breadcrumb
// name lookup) can't return a directory the backend no longer has.
export function evictDirs(uuids: readonly string[]): void {
	for (const uuid of uuids) {
		dirsByUuid.delete(uuid)
		namesByUuid.delete(uuid)
	}
}
