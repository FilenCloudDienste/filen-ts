import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createDocxWordCountStore, type DocxCountSource } from "@/features/preview/components/docxWordCount.logic"

// The status bar's word count: counted once changes pause, again only when the document changed, the selection's
// count beside it, and nothing done while nothing shows it.

function source(): Omit<DocxCountSource, "count"> & {
	count: () => Promise<number>
	doc: object
	selection: object
	words: number
	selectedWords: number | undefined
	counts: number
	listeners: Set<() => void>
	change: () => void
} {
	const state = {
		doc: {},
		selection: {},
		words: 3,
		selectedWords: undefined as number | undefined,
		counts: 0,
		listeners: new Set<() => void>(),
		change: () => {
			for (const listener of state.listeners) listener()
		},
		subscribe: (listener: () => void) => {
			state.listeners.add(listener)

			return () => {
				state.listeners.delete(listener)
			}
		},
		documentKey: () => state.doc,
		selectionKey: () => state.selection,
		count: () => {
			state.counts += 1

			return Promise.resolve(state.words)
		},
		selected: () => state.selectedWords
	}

	return state
}

beforeEach(() => {
	vi.useFakeTimers()
})

afterEach(() => {
	vi.useRealTimers()
})

describe("word count store", () => {
	it("counts nothing until shown, then counts at once", async () => {
		const counted = source()
		const store = createDocxWordCountStore(counted, 100)

		expect(counted.counts).toBe(0)
		expect(counted.listeners.size).toBe(0)

		const stop = store.subscribe(() => undefined)

		await vi.advanceTimersByTimeAsync(0)
		expect(store.get()).toEqual({ words: 3, selected: undefined })
		expect(counted.counts).toBe(1)
		stop()
		expect(counted.listeners.size).toBe(0)
	})

	it("counts again once changes pause, and only when the document changed", async () => {
		const counted = source()
		const store = createDocxWordCountStore(counted, 100)
		const listener = vi.fn()

		store.subscribe(listener)
		await vi.advanceTimersByTimeAsync(0)

		// A selection move: no count.
		counted.selection = {}
		counted.change()
		await vi.advanceTimersByTimeAsync(150)
		expect(counted.counts).toBe(1)

		// Edits in a row: one count after the last.
		counted.words = 5

		for (let k = 0; k < 4; k++) {
			counted.doc = {}
			counted.change()
			await vi.advanceTimersByTimeAsync(50)
		}

		expect(counted.counts).toBe(1)
		await vi.advanceTimersByTimeAsync(100)
		expect(counted.counts).toBe(2)
		expect(store.get().words).toBe(5)
		expect(listener).toHaveBeenCalledTimes(2)
	})

	it("counts the selection beside the document", async () => {
		const counted = source()
		const store = createDocxWordCountStore(counted, 100)

		store.subscribe(() => undefined)
		await vi.advanceTimersByTimeAsync(0)
		counted.selection = {}
		counted.selectedWords = 2
		counted.change()
		await vi.advanceTimersByTimeAsync(100)
		expect(store.get()).toEqual({ words: 3, selected: 2 })

		counted.selection = {}
		counted.selectedWords = undefined
		counted.change()
		await vi.advanceTimersByTimeAsync(100)
		expect(store.get()).toEqual({ words: 3, selected: undefined })
	})

	it("keeps only the latest count when an earlier one finishes after it", async () => {
		const counted = source()
		const resolvers: ((words: number) => void)[] = []

		counted.count = () =>
			new Promise<number>(resolve => {
				resolvers.push(resolve)
			})

		const store = createDocxWordCountStore(counted, 100)

		store.subscribe(() => undefined)
		counted.doc = {}
		counted.change()
		await vi.advanceTimersByTimeAsync(100)
		resolvers[1]?.(9)
		resolvers[0]?.(1)
		await vi.advanceTimersByTimeAsync(0)
		expect(store.get().words).toBe(9)
	})
})
