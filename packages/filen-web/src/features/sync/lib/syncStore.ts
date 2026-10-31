import { create } from "zustand"
import { useShallow } from "zustand/shallow"
import { replaceEqualDeep } from "@tanstack/react-query"
import type { DesktopSync, DesktopSyncHostState, DesktopSyncImportNote, DesktopSyncOverview, DesktopSyncPair } from "@filen/shared/desktop"
import { desktopBridge } from "@/lib/desktop"
import { log } from "@/lib/log"
import { aggregateSyncState, type SyncAggregate } from "@/features/sync/lib/syncStatus.logic"

interface SyncState {
	// The shell's latest overview; null until it answered, and always in a browser.
	overview: DesktopSyncOverview | null
	// The add-pair dialog, opened from the sidebar or the empty index.
	addPairOpen: boolean
}

// This page's mirror of the shell's sync overview. Each push is structurally shared with the one before it, so
// an unchanged pair (or host) keeps its object and a selector on it re-renders nothing while another pair syncs.
export const useSyncStore = create<SyncState>(() => ({ overview: null, addPairOpen: false }))

function apply(overview: DesktopSyncOverview): void {
	useSyncStore.setState(state => ({ overview: replaceEqualDeep(state.overview, overview) }))
}

let loaded = false

// Starts following the shell's overview, once per page. Listening is what keeps the shell forwarding it.
export function loadSync(): void {
	const sync = desktopBridge()?.sync

	if (sync === undefined || loaded) {
		return
	}

	loaded = true
	sync.onOverview(apply)

	// onOverview calls back right away only with an overview the preload already holds.
	sync.overview().then(
		overview => {
			if (useSyncStore.getState().overview === null) {
				apply(overview)
			}
		},
		(error: unknown) => {
			log.warn("sync", "overview could not be read", error)
		}
	)
}

// The bridge's sync namespace. The Sync section renders only with the bridge (its route redirects otherwise).
export function syncApi(): DesktopSync {
	const sync = desktopBridge()?.sync

	if (sync === undefined) {
		throw new Error("Sync needs the desktop app")
	}

	return sync
}

export function openAddPair(): void {
	useSyncStore.setState({ addPairOpen: true })
}

export function closeAddPair(): void {
	useSyncStore.setState({ addPairOpen: false })
}

export function useSyncHost(): DesktopSyncHostState | null {
	return useSyncStore(state => state.overview?.host ?? null)
}

export function useSyncImportNote(): DesktopSyncImportNote | null {
	return useSyncStore(state => state.overview?.importNote ?? null)
}

// null while the first overview is in flight.
export function useSyncPairIds(): string[] | null {
	return useSyncStore(useShallow(state => state.overview?.pairs.map(pair => pair.id) ?? null))
}

export function useSyncPair(pairId: string): DesktopSyncPair | undefined {
	return useSyncStore(state => state.overview?.pairs.find(pair => pair.id === pairId))
}

export function useSyncAggregate(): SyncAggregate | null {
	return useSyncStore(state => aggregateSyncState(state.overview))
}
