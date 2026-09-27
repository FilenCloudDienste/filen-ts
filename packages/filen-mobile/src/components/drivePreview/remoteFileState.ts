import useSocketStore from "@/stores/useSocket.store"
import { createUnlockedNotices, createUnlockedToaster, unlockedForegroundGate } from "@/lib/unlockedForeground"
import type { FileInNormalParent } from "@/features/drive/queries/useDriveItems.query"
import alerts from "@/lib/alerts"
import prompts from "@/lib/prompts"
import events from "@/lib/events"
import type { DriveItem } from "@/types"

// What the drive preview knows of a file across its editors: an editor remounts on each save of its own and
// each newer version it follows (the file queries re-key on the new uuid), so what must outlive one mount is
// kept here, per lineage (the file's stable id).

// Counts the socket's connections: each is told apart by it, even two made within the same millisecond.
let connectionSeq = 0

useSocketStore.subscribe((state, prev) => {
	if (state.connectedAt !== prev.connectedAt) {
		connectionSeq++
	}
})

// The socket connection whose changes reach this device as events; null while the socket is down.
export function liveConnection(): number | null {
	return useSocketStore.getState().state === "connected" ? connectionSeq : null
}

export type LineageState = {
	// The connection during which the file's newest version was last known for certain (a check's read, a
	// save's result), and that version, kept current by the connection's events since. While that connection
	// is the live one, an editor showing that version saves without a check first.
	covered: number | null
	newest: string | null
	// A check for changes missed while the socket was down, that no editor could act on (its own save was
	// uploading, or it was torn down): run by the next editor of the file on screen.
	recheck: boolean
	// Counts what changed the file since (an event of it: a newer version, a rename or move, a deletion or
	// restore), so a read begun before one is never taken for what the file is now.
	epoch: number
	// The check's directory read for a connection while it is under way: an editor torn down meanwhile hands
	// it to the next instead of reading again, unless the file changed since it began. Once answered, it is no
	// one's to reuse: what it saw ages.
	read: { connection: number | null; epoch: number; lookup: Promise<FileInNormalParent>; answered: boolean } | null
	// Remote-change prompts about the file, pending or on screen: no save goes over what they ask about.
	asking: number
}

const lineages = new Map<string, LineageState>()

export function lineageState(stableUuid: string): LineageState {
	let state = lineages.get(stableUuid)

	if (state === undefined) {
		state = { covered: null, newest: null, recheck: false, epoch: 0, read: null, asking: 0 }

		lineages.set(stableUuid, state)
	}

	return state
}

// Whether `uuid` is the file's newest version for certain: known during the live connection, and no event of it
// since. A copy read from elsewhere (a listing from before a gap, a search hit) is not, unless it is that version.
export function isCovered(stableUuid: string, uuid: string): boolean {
	const connection = liveConnection()
	const state = lineages.get(stableUuid)

	return connection !== null && state?.covered === connection && state.newest === uuid
}

// `uuid` is the file's newest version, known during `connection`.
export function markCovered(stableUuid: string, connection: number | null, uuid: string): void {
	if (connection === null || connection !== liveConnection()) {
		return
	}

	const state = lineageState(stableUuid)

	state.covered = connection
	state.newest = uuid
}

// The file changed: a read begun before is no longer what it is.
function changed(state: LineageState): void {
	state.epoch++
	state.read = null
}

function lineageOfItem(item: DriveItem): LineageState | undefined {
	return item.type === "file" && item.data.stableUuid !== undefined ? lineages.get(item.data.stableUuid) : undefined
}

// A file's events keep what is known of it current, whether or not an editor of it is open.
events.subscribe("driveFileRevised", ({ item }) => {
	const state = lineageOfItem(item)

	if (state !== undefined) {
		changed(state)
		state.newest = item.data.uuid
	}
})

// A rename or move (and a version followed or saved here): the name and directory a read saw are gone.
events.subscribe("driveItemUpdated", ({ item }) => {
	const state = lineageOfItem(item)

	if (state !== undefined) {
		changed(state)
	}
})

// The file's lineage when the event (or the cache) told it; otherwise the event names a version only, of
// whichever file, and every read goes.
function lineagesOf(stableUuid: string | undefined): Iterable<LineageState> {
	if (stableUuid === undefined) {
		return lineages.values()
	}

	const state = lineages.get(stableUuid)

	return state !== undefined ? [state] : []
}

events.subscribe("driveFileGone", ({ uuid, stableUuid }) => {
	for (const state of lineagesOf(stableUuid)) {
		changed(state)

		if (state.newest === uuid) {
			state.newest = null
		}
	}
})

events.subscribe("driveFileRestored", ({ stableUuid }) => {
	for (const state of lineagesOf(stableUuid)) {
		changed(state)
	}
})

// A drive event the socket could not read: nothing known of any file can be trusted, so every save checks.
events.subscribe("driveChangesMissed", () => {
	for (const state of lineages.values()) {
		changed(state)
		state.covered = null
		state.newest = null
	}
})

let toaster: ReturnType<typeof createUnlockedToaster> | null = null

// A routine toast about a previewed file, shown once the app is unlocked and in front, one after another, the
// latest of each kind per file. Owned by the preview, not its editors (a follow tears the editor down), and
// dropped when the preview closes (endPreviewNotices).
export function previewToast(fileKey: string, kind: string, message: string): void {
	toaster ??= createUnlockedToaster(next => {
		alerts.normal(next)
	})

	toaster.notify(`${fileKey}:${kind}`, message)
}

// A notice about a save already made that must be read whole: an alert, kept even after the preview closes.
export const previewNotice = createUnlockedNotices(async (title, message) => {
	await prompts.info({ title, message, gate: unlockedForegroundGate })
})

// The preview closed: its toasts still waiting go with it.
export function endPreviewNotices(): void {
	toaster?.dispose()
	toaster = null
}

// Nothing of the ended account's files carries over.
events.subscribe("logout", () => {
	lineages.clear()
	endPreviewNotices()
})
