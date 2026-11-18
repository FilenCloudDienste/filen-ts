import type { ReferenceResolver, ReferenceSourceFactory } from "@/features/preview/lib/referenceResolver"
import { readOrigin } from "@/features/preview/lib/referenceResolver"
import { referenceWalker, type ReferenceListing } from "@/features/preview/lib/referenceResolver.logic"
import type { PreviewAccessMode } from "@/features/preview/lib/accessMode"
import type { ArchiveSource } from "@/features/archive/lib/archiveSource"
import type { EntryStore } from "@/features/archive/lib/entryStore"
import { entryRequest, type EntryRequest } from "@/features/archive/lib/entryDownload"
import { entryLeaseOrigin, leaseEntry } from "@/features/archive/lib/archiveHandle"
import { entryPlanOf } from "@/features/archive/lib/entryAccess.logic"

// An archive entry's references, from the archive's own listing: its directory and the directories below it. An entry
// the SDK cannot read alone (a bare tar's member) is listed as not readable. Each one is read through a lease of its own
// on the archive's reader for the password the viewed entry took.

export function entryListing(source: ArchiveSource, store: EntryStore, dir: number): ReferenceListing<number, EntryRequest> {
	return {
		dirs: store.childDirs(dir).map(child => [store.dirName(child), child] as const),
		files: store.childEntries(dir).map(slot => [store.name(slot), entryRequest(source, store, slot)] as const)
	}
}

const NO_EVENTS = {
	phase: () => undefined,
	verified: () => undefined,
	failed: () => undefined
}

async function readEntry(
	request: EntryRequest,
	store: EntryStore,
	password: string | undefined,
	access: PreviewAccessMode,
	cap: number,
	signal: AbortSignal
) {
	const leaseId = crypto.randomUUID()
	const file = request.params.archive
	const { index } = request.params.entry
	const release = leaseEntry({
		leaseId,
		file,
		anon: request.anon,
		password,
		plan: entryPlanOf(store, index, request.size, request.params.maxSolidSkip, false),
		events: NO_EVENTS
	})

	return await readOrigin(entryLeaseOrigin(leaseId, file, request.anon, index, request.size), access, cap, signal).finally(release)
}

// `index`: the viewed entry's index in the archive.
export function entryReferences(
	source: ArchiveSource,
	store: EntryStore,
	index: number,
	password: string | undefined,
	access: PreviewAccessMode
): ReferenceSourceFactory {
	return (): ReferenceResolver | null => {
		const slot = store.slotOfIndex(index)

		if (slot === -1) return null

		const lookup = referenceWalker(
			() => Promise.resolve(entryListing(source, store, store.parent(slot))),
			dir => Promise.resolve(entryListing(source, store, dir))
		)

		return async path => {
			const found = await lookup(path)

			if (found.status !== "found") return found

			const request = found.file

			return { status: "found", size: request.size, read: (cap, signal) => readEntry(request, store, password, access, cap, signal) }
		}
	}
}
