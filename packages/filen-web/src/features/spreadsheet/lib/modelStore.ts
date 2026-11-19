import { useSyncExternalStore } from "react"
import type { SheetGridModel } from "@filen/office/react/sheet"
import { createListenerSet, type ListenerSet } from "@/lib/listenerSet"

// A value held per grid for the UI around it (a dialog or bar open on it, what it has selected), read by hooks and
// set from anywhere that holds the grid. `equal` decides whether a set changes it: an equal value notifies no one,
// and an `equal` that is never true notifies on every set.
export interface ModelStore<T> {
	get: (model: SheetGridModel) => T
	set: (model: SheetGridModel, value: T) => void
	useValue: (model: SheetGridModel) => T
}

interface Held<T> {
	value: T
	readonly listeners: ListenerSet<void>
	// One per grid, so the hook keeps its subscription across renders.
	readonly subscribe: (listener: () => void) => () => void
}

export function createModelStore<T>(initial: T, equal: (a: T, b: T) => boolean = Object.is): ModelStore<T> {
	const held = new WeakMap<SheetGridModel, Held<T>>()

	const heldOf = (model: SheetGridModel): Held<T> => {
		let entry = held.get(model)

		if (entry === undefined) {
			const listeners = createListenerSet("spreadsheet")

			entry = { value: initial, listeners, subscribe: listener => listeners.subscribe(listener) }
			held.set(model, entry)
		}

		return entry
	}

	return {
		get: model => {
			const entry = held.get(model)

			return entry === undefined ? initial : entry.value
		},
		set: (model, value) => {
			const entry = heldOf(model)

			if (equal(entry.value, value)) {
				return
			}

			entry.value = value
			entry.listeners.emit()
		},
		useValue: model => {
			const entry = heldOf(model)
			const read = () => entry.value

			return useSyncExternalStore(entry.subscribe, read, read)
		}
	}
}

// Whether a workbook's structure is protected now, as its sheet tabs last asked the session (after every change): the
// one query both the tabs and the ribbon's workbook button read.
export const workbookStructureLocks = createModelStore(false)
