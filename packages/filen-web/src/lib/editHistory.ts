// Undo/redo over whole recipes, for any editor (recipes are small and immutable, so an entry is a reference, never a
// copy; a push of the current reference is no step).

// Pushes under one key closer together than this are one step: a slider drag, held arrow keys, a handle drag.
export const COALESCE_MS = 500

export const HISTORY_LIMIT = 200

export interface EditHistory<R> {
	readonly current: R
	readonly canUndo: boolean
	readonly canRedo: boolean
	// Records `recipe` as the new current state and drops the redo branch. With the same `coalesceKey` as the
	// previous push, within COALESCE_MS of it and no seal() between, it replaces that push's entry instead.
	push(recipe: R, coalesceKey?: string): void
	// Ends the running coalesced step (pointerup): the next push starts a new one.
	seal(): void
	// Both return the new current recipe (unchanged when there is nothing to undo or redo).
	undo(): R
	redo(): R
}

export function createHistory<R>(initial: R, now: () => number = Date.now): EditHistory<R> {
	const entries: R[] = [initial]
	let index = 0
	let openKey: string | null = null
	let openAt = 0

	const at = (i: number): R => {
		const entry = entries[i]

		if (entry === undefined) {
			throw new Error("history index out of range")
		}

		return entry
	}

	return {
		get current() {
			return at(index)
		},
		get canUndo() {
			return index > 0
		},
		get canRedo() {
			return index < entries.length - 1
		},
		push(recipe, coalesceKey) {
			const time = now()

			if (recipe === at(index)) {
				return
			}

			// The open step is the newest entry only while no undo has happened since, which clears openKey.
			if (coalesceKey !== undefined && coalesceKey === openKey && time - openAt <= COALESCE_MS && index > 0) {
				entries[index] = recipe
				openAt = time

				return
			}

			entries.length = index + 1
			entries.push(recipe)
			index++

			if (entries.length > HISTORY_LIMIT) {
				entries.shift()
				index--
			}

			openKey = coalesceKey ?? null
			openAt = time
		},
		seal() {
			openKey = null
		},
		undo() {
			openKey = null

			if (index > 0) {
				index--
			}

			return at(index)
		},
		redo() {
			openKey = null

			if (index < entries.length - 1) {
				index++
			}

			return at(index)
		}
	}
}
