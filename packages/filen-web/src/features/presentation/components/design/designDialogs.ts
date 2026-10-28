import { useSyncExternalStore } from "react"
import type { PresentationStore } from "@filen/office/react/presentation"

// The Design tab's open dialog (Slide size, Format background), per deck store. The ribbon asks for it (its groups
// unmount when an overflow menu closes) and DesignDialogsHost shows it beside the editor; while no host is mounted the
// asking control shows it itself.

export type DesignDialog =
	| {
			readonly kind: "size"
			readonly initial: { readonly cx: number; readonly cy: number; readonly type?: string } | undefined
			readonly key: number
	  }
	| { readonly kind: "background"; readonly key: number }

interface DesignDialogState {
	dialog: DesignDialog | undefined
	hosts: number
	next: number
	readonly listeners: Set<() => void>
	// One per store, so React keeps its subscription across renders.
	readonly subscribe: (listener: () => void) => () => void
}

const states = new WeakMap<PresentationStore, DesignDialogState>()

function stateOf(store: PresentationStore): DesignDialogState {
	let state = states.get(store)

	if (state === undefined) {
		const listeners = new Set<() => void>()

		state = {
			dialog: undefined,
			hosts: 0,
			next: 1,
			listeners,
			subscribe: listener => {
				listeners.add(listener)

				return () => {
					listeners.delete(listener)
				}
			}
		}
		states.set(store, state)
	}

	return state
}

function changed(state: DesignDialogState): void {
	for (const listener of state.listeners) listener()
}

export function openDesignDialog(
	store: PresentationStore,
	dialog: { readonly kind: "background" } | Omit<Extract<DesignDialog, { kind: "size" }>, "key">
): void {
	const state = stateOf(store)

	state.dialog = { ...dialog, key: state.next++ }
	changed(state)
}

export function closeDesignDialog(store: PresentationStore): void {
	const state = stateOf(store)

	if (state.dialog === undefined) return

	state.dialog = undefined
	changed(state)
}

// A host shows the dialogs from mount to unmount.
export function registerDesignHost(store: PresentationStore): () => void {
	const state = stateOf(store)

	state.hosts++
	changed(state)

	return () => {
		state.hosts--
		changed(state)
	}
}

export function subscribeDesignDialogs(store: PresentationStore): (listener: () => void) => () => void {
	return stateOf(store).subscribe
}

export function useDesignDialog(store: PresentationStore | undefined): DesignDialog | undefined {
	return useSyncExternalStore(store === undefined ? noSubscribe : subscribeDesignDialogs(store), () =>
		store === undefined ? undefined : stateOf(store).dialog
	)
}

export function useDesignHosted(store: PresentationStore | undefined): boolean {
	return useSyncExternalStore(
		store === undefined ? noSubscribe : subscribeDesignDialogs(store),
		() => store !== undefined && stateOf(store).hosts > 0
	)
}

function noSubscribe(): () => void {
	return () => undefined
}
