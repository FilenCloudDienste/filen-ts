import type { DirMeta, FileMeta } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { type PreviewSource } from "@/features/preview/lib/previewSource"
import { log } from "@/lib/log"

// The seam that keeps an OPEN preview pager in sync with realtime drive mutations from ANOTHER device.
// The pager reads a frozen PreviewSource[] snapshot held in the dialog host's own React state (taken at
// open time), so a socket cache-patch to the listing query never reaches it — this module is the missing
// wire. The drive socket handler EMITS one of these events for a mutation that touches an item; the dialog
// host SUBSCRIBES and folds the event into its frozen snapshot with the pure reducer below. Modelled on
// filen-mobile's gallery driveItemUpdated / driveItemRemoved subscribers, over the web's frozen-snapshot
// pager instead of a live store. Emitting with no open preview is a silent no-op (zero listeners).

// Removed: the item left this listing (trash / move-out / permanent-delete / restore-from-trash) — drop
// it from the pager (advance to a neighbour, or close once it was the only slot). Replaced: a version
// restore rotated the item's uuid — swap the whole item so the page reseeds fresh content. FileMeta /
// FolderMeta: a rename (or other metadata change) — merge the new meta into the frozen item so the header
// title updates in place. The two meta arms stay split because FileMeta and DirMeta are indistinguishable
// at runtime (same `{ type: "decoded", … }` wrapper) — the emitter knows which family fired.
export type PreviewReconcileEvent =
	| { type: "removed"; uuid: string }
	| { type: "replaced"; previousUuid: string; item: DriveItem }
	| { type: "fileMeta"; uuid: string; meta: FileMeta }
	| { type: "folderMeta"; uuid: string; meta: DirMeta }

export interface PreviewPagerState {
	sources: PreviewSource[]
	index: number
}

type Listener = (event: PreviewReconcileEvent) => void

// At most one subscriber in practice (the single mounted dialog host), but a Set keeps the contract
// symmetric with the socket registry and tolerates a StrictMode double-subscribe.
const listeners: Set<Listener> = new Set<Listener>()

// Subscribe the open preview to reconcile events; returns the unsubscribe fn. Called from the dialog
// host's mount effect.
export function subscribePreviewReconcile(listener: Listener): () => void {
	listeners.add(listener)

	return () => {
		listeners.delete(listener)
	}
}

// A throwing subscriber is logged and never aborts the fan-out (mirrors the socket bridge's dispatch).
function emit(event: PreviewReconcileEvent): void {
	for (const listener of listeners) {
		try {
			listener(event)
		} catch (e) {
			log.error("preview", "reconcile listener threw", event.type, e)
		}
	}
}

export function emitPreviewItemRemoved(uuid: string): void {
	emit({ type: "removed", uuid })
}

export function emitPreviewItemReplaced(previousUuid: string, item: DriveItem): void {
	emit({ type: "replaced", previousUuid, item })
}

export function emitPreviewFileMetaChanged(uuid: string, meta: FileMeta): void {
	emit({ type: "fileMeta", uuid, meta })
}

export function emitPreviewFolderMetaChanged(uuid: string, meta: DirMeta): void {
	emit({ type: "folderMeta", uuid, meta })
}

// Drops the drive source carrying `uuid` and keeps the same item visible: an earlier slot's removal
// shifts everything left by one, so the anchor steps back one; removing the current (or a later) slot
// leaves the anchor where it is, clamped to the new last slot. Returns null when the removed slot was the
// only one left (the host closes the preview). An absent uuid leaves the state untouched — this event is
// for a different listing's item. Mirrors filen-mobile's driveItemRemoved anchor math.
function removeSource(state: PreviewPagerState, uuid: string): PreviewPagerState | null {
	const removedIndex = state.sources.findIndex(source => source.type === "drive" && source.item.data.uuid === uuid)

	if (removedIndex === -1) {
		return state
	}

	const remaining = state.sources.filter((_, sourceIndex) => sourceIndex !== removedIndex)

	if (remaining.length === 0) {
		return null
	}

	const anchored = removedIndex < state.index ? state.index - 1 : state.index

	return { sources: remaining, index: Math.max(0, Math.min(anchored, remaining.length - 1)) }
}

// Swaps the whole item on every drive source matching `previousUuid` (a version restore rotates the uuid,
// so the frozen snapshot's stale copy would otherwise stream a uuid the backend no longer serves). Index
// is unchanged — the slot stays in place, only its content reseeds.
function replaceSource(sources: PreviewSource[], previousUuid: string, item: DriveItem): PreviewSource[] {
	return sources.map(source => (source.type === "drive" && source.item.data.uuid === previousUuid ? { type: "drive", item } : source))
}

// Merges fresh file meta into the matching OWNED-file source and re-narrows so the derived name /
// undecryptable flag reflect the rename. Only the base "file" arm is rebuildable from `{ ...data, meta }`
// (a shared arm carries extra sharing context this sparse event can't reconstruct) — the same arm
// restriction the listing-cache patch uses, so a shared item's rename updates neither surface, staying
// consistent.
function patchFileMeta(sources: PreviewSource[], uuid: string, meta: FileMeta): PreviewSource[] {
	return sources.map(source =>
		source.type === "drive" && source.item.type === "file" && source.item.data.uuid === uuid
			? { type: "drive", item: narrowItem({ ...source.item.data, meta }) }
			: source
	)
}

function patchFolderMeta(sources: PreviewSource[], uuid: string, meta: DirMeta): PreviewSource[] {
	return sources.map(source =>
		source.type === "drive" && source.item.type === "directory" && source.item.data.uuid === uuid
			? { type: "drive", item: narrowItem({ ...source.item.data, meta }) }
			: source
	)
}

// Pure fold of one reconcile event into the pager state — the dialog host runs this inside its
// setActiveDialog updater. Returns null only when a removal emptied the pager (close the preview);
// otherwise the (possibly unchanged) next state.
export function reconcilePreviewSources(state: PreviewPagerState, event: PreviewReconcileEvent): PreviewPagerState | null {
	switch (event.type) {
		case "removed":
			return removeSource(state, event.uuid)
		case "replaced":
			return { sources: replaceSource(state.sources, event.previousUuid, event.item), index: state.index }
		case "fileMeta":
			return { sources: patchFileMeta(state.sources, event.uuid, event.meta), index: state.index }
		case "folderMeta":
			return { sources: patchFolderMeta(state.sources, event.uuid, event.meta), index: state.index }
	}
}
