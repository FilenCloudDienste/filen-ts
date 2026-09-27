import type { DirMeta, FileMeta } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { type PreviewSource } from "@/features/preview/lib/previewSource"
import { type PreviewRevision } from "@/features/preview/lib/remoteChange.logic"
import { usePreviewUnsavedGuardStore } from "@/features/preview/store/usePreviewUnsavedGuard"
import { log } from "@/lib/log"

// The seam that keeps an OPEN preview pager in sync with realtime drive mutations from ANOTHER device.
// The pager reads a frozen PreviewSource[] snapshot held in the dialog host's own React state (taken at
// open time), so a socket cache-patch to the listing query never reaches it — this module is the missing
// wire. The drive socket handler EMITS one of these events for a mutation that touches an item; the dialog
// host SUBSCRIBES and folds the event into its frozen snapshot with the pure reducer below. Modelled on
// filen-mobile's gallery driveItemUpdated / driveItemRemoved subscribers, over the web's frozen-snapshot
// pager instead of a live store. Emitting with no open preview is a silent no-op (zero listeners).

// Removed: the item left this listing (trash / move-out / permanent-delete) — drop
// it from the pager (advance to a neighbour, or close once it was the only slot). Moved: a file left for
// another directory; the same, except that the overlay keeps a file with unsaved edits open on its new
// location. Restored: an item came back out of the trash, which the trash's own pager drops like a
// removal. FileMeta / FolderMeta: a rename (or other metadata change) — merge the new meta into the
// frozen item so the header title updates in place. The two meta arms stay split because FileMeta and
// DirMeta are indistinguishable at runtime (same `{ type: "decoded", … }` wrapper) — the emitter knows
// which family fired. Revised (a newer version of a file, saved elsewhere or restored) and resync (the
// socket came back after a drop, so revisions may have been missed) leave the pager alone: the overlay
// answers them itself (usePreviewRemoteChanges), as the answer depends on its unsaved edits.
export type PreviewReconcileEvent =
	| { type: "removed"; uuid: string }
	| { type: "restored"; uuid: string }
	| { type: "moved"; item: DriveItem }
	| { type: "revised"; revision: PreviewRevision }
	| { type: "resync" }
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

// A restore out of the trash: the trash's pager drops the item, and an overlay asking about the file's
// deletion can stop asking.
export function emitPreviewItemRestored(uuid: string): void {
	emit({ type: "restored", uuid })
}

export function emitPreviewItemMoved(item: DriveItem): void {
	emit({ type: "moved", item })
}

export function emitPreviewFileRevised(revision: PreviewRevision): void {
	emit({ type: "revised", revision })
}

export function emitPreviewResync(): void {
	emit({ type: "resync" })
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

// Merges fresh file meta into the matching OWNED-file source and re-narrows so the derived name /
// undecryptable flag reflect the rename. Only the base "file" arm is rebuildable from `{ ...data, meta }`
// (a shared arm carries extra sharing context this sparse event can't reconstruct) — the same arm
// restriction the listing-cache patch uses, so a shared item's rename updates neither surface, staying
// consistent. The state itself comes back when no slot matched, so the host skips its re-render.
function patchMeta(
	state: PreviewPagerState,
	uuid: string,
	patch: (source: Extract<PreviewSource, { type: "drive" }>) => PreviewSource | null
): PreviewPagerState {
	const matched = state.sources.findIndex(source => source.type === "drive" && source.item.data.uuid === uuid)
	const current = state.sources[matched]

	if (current?.type !== "drive") {
		return state
	}

	const next = patch(current)

	if (next === null) {
		return state
	}

	return { sources: state.sources.with(matched, next), index: state.index }
}

// The uuid of the slot on screen while it holds unsaved edits. A removal of that slot is the overlay's to
// answer (it asks what to do with the edits, or follows a moved file), so the pager keeps it meanwhile.
export function previewProtectedUuid(state: PreviewPagerState): string | null {
	const source = state.sources[state.index]

	return usePreviewUnsavedGuardStore.getState().dirty && source?.type === "drive" ? source.item.data.uuid : null
}

// Pure fold of one reconcile event into the pager state — the dialog host runs this inside its
// setActiveDialog updater, with previewProtectedUuid's answer. Returns null only when a removal emptied
// the pager (close the preview); otherwise the next state, which is `state` itself when the event
// changes nothing here (most events are about files the pager does not hold).
export function reconcilePreviewSources(
	state: PreviewPagerState,
	event: PreviewReconcileEvent,
	protectedUuid: string | null = null
): PreviewPagerState | null {
	switch (event.type) {
		case "removed":
		case "restored":
			return event.uuid === protectedUuid ? state : removeSource(state, event.uuid)
		case "moved":
			return event.item.data.uuid === protectedUuid ? state : removeSource(state, event.item.data.uuid)
		case "revised":
		case "resync":
			return state
		case "fileMeta":
			return patchMeta(state, event.uuid, source =>
				source.item.type === "file" ? { type: "drive", item: narrowItem({ ...source.item.data, meta: event.meta }) } : null
			)
		case "folderMeta":
			return patchMeta(state, event.uuid, source =>
				source.item.type === "directory" ? { type: "drive", item: narrowItem({ ...source.item.data, meta: event.meta }) } : null
			)
	}
}
