import type { EntryReaderEvents } from "@/workers/originSource"
import type { ArchiveHandle, LeasedOrigin } from "@/features/archive/lib/archiveHandle"
import { createEntryStore } from "@/features/archive/lib/entryStore"
import { pickIworkPreview, type IworkPreviewKind } from "@/features/iwork/lib/iworkPreview.logic"

// The rendering an iWork package carries, leased through its archive handle.
export interface IworkPreviewEntry {
	readonly lease: LeasedOrigin
	readonly kind: IworkPreviewKind
	readonly index: number
	readonly name: string
	readonly size: number
	// NaN when absent.
	readonly modified: number
}

export interface OpenIworkPreviewOptions {
	readonly signal: AbortSignal
	readonly onWaiting: (waiting: boolean) => void
	readonly events: EntryReaderEvents
}

// Lists the package behind `handle` and leases the best rendering it holds; null when it holds none. The listing is
// dropped once the rendering is found. A lease taken after `signal` aborted is released at once.
export async function openIworkPreview(handle: ArchiveHandle, options: OpenIworkPreviewOptions): Promise<IworkPreviewEntry | null> {
	const store = createEntryStore()

	await handle.list(
		batch => {
			store.append(batch)
		},
		{ signal: options.signal, onWaiting: options.onWaiting }
	)

	const pick = pickIworkPreview(path => handle.findByPath(store, path))

	if (pick === null) {
		return null
	}

	const slot = pick.found
	const lease = await handle.origin(store, slot, options.events)

	if (options.signal.aborted) {
		lease.release()

		return null
	}

	return {
		lease,
		kind: pick.kind,
		index: store.index(slot),
		name: store.name(slot),
		size: store.size(slot),
		modified: store.modified(slot)
	}
}
