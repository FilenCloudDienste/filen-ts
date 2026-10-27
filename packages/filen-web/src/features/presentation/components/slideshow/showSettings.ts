import { useSyncExternalStore } from "react"
import type { PresentationStore, ShowOptions } from "@filen/office/react/presentation"

// What Set Up Slide Show chose for an open deck it could not save it in (a deck that can only be viewed, or a refused
// change; used by every show started until the deck is closed, in place of the deck's own settings, OpenInfo.show),
// and whether its dialog is open. Kept per deck store, gone with it. The dialog
// is asked for from the ribbon (whose groups unmount when an overflow menu closes) and shown by the deck's show layer.

interface DeckShowState {
	chosen: ShowOptions | undefined
	setUpOpen: boolean
	readonly listeners: Set<() => void>
}

const states = new WeakMap<PresentationStore, DeckShowState>()

function stateOf(store: PresentationStore): DeckShowState {
	let state = states.get(store)

	if (state === undefined) {
		state = { chosen: undefined, setUpOpen: false, listeners: new Set() }
		states.set(store, state)
	}

	return state
}

function changed(state: DeckShowState): void {
	for (const listener of state.listeners) listener()
}

// undefined: the shows use the deck's own settings again.
export function setShowOptions(store: PresentationStore, options: ShowOptions | undefined): void {
	const state = stateOf(store)

	state.chosen = options
	changed(state)
}

export function setSetUpOpen(store: PresentationStore, open: boolean): void {
	const state = stateOf(store)

	if (state.setUpOpen === open) return

	state.setUpOpen = open
	changed(state)
}

function subscribe(store: PresentationStore): (listener: () => void) => () => void {
	return listener => {
		const state = stateOf(store)

		state.listeners.add(listener)

		return () => {
			state.listeners.delete(listener)
		}
	}
}

export function useChosenShowOptions(store: PresentationStore): ShowOptions | undefined {
	return useSyncExternalStore(subscribe(store), () => stateOf(store).chosen)
}

export function useSetUpOpen(store: PresentationStore): boolean {
	return useSyncExternalStore(subscribe(store), () => stateOf(store).setUpOpen)
}
