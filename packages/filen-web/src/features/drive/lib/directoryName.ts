import { log } from "@/lib/log"
import { sharedDirName, type SharedDirContext } from "@/features/drive/lib/cache"
import type { SharedPathHint } from "@/features/drive/lib/sharedPath"

// Injected so the worker's name resolve stays node-testable: the worker binds them to its live client,
// its in-memory caches and its coalesced lookups.
export interface DirectoryNameDeps {
	getCachedName: (uuid: string) => string | undefined
	// Owned only: cache-first getDirOptional (v3/dir), which answers for the account's own directories.
	lookupOwnedName: (uuid: string) => Promise<string | undefined>
	// Shared only: the share-context walk the shared listings already use (sharedPath.ts).
	resolveSharedContext: (hint: SharedPathHint, uuid: string) => Promise<SharedDirContext | undefined>
}

// A breadcrumb crumb's display name. `hint` picks the resolution path: absent for an owned directory,
// the route's shared variant and splat chain for a shared one. v3/dir is owner-only and fails with
// FolderNotFound for a directory someone else owns, so a shared crumb never reaches it. Never throws:
// an unresolvable uuid is null, and the caller shows the raw uuid for that one crumb.
export async function lookupDirectoryName(deps: DirectoryNameDeps, uuid: string, hint?: SharedPathHint): Promise<string | null> {
	const cached = deps.getCachedName(uuid)

	if (cached !== undefined) {
		return cached
	}

	try {
		if (hint === undefined) {
			return (await deps.lookupOwnedName(uuid)) ?? null
		}

		const context = await deps.resolveSharedContext(hint, uuid)

		return context === undefined ? null : (sharedDirName(context.dir) ?? null)
	} catch (e) {
		log.warn("directory-name", "unresolved directory name", uuid, e)

		return null
	}
}
