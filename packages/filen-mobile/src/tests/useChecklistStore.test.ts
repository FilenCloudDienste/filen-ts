import { describe, it, expect } from "vitest"
import { createChecklistStore } from "@/features/notes/store/useChecklist.store"
import { type Checklist } from "@filen/utils"

const live: Checklist = [
	{ id: "live-1", checked: false, content: "buy milk" },
	{ id: "live-2", checked: false, content: "buy eggs" }
]
const history: Checklist = [{ id: "history-1", checked: true, content: "old content" }]

describe("createChecklistStore", () => {
	it("starts with empty initial state", () => {
		const store = createChecklistStore()
		const state = store.getState()

		expect(state.parsed).toEqual([])
		expect(state.ids).toEqual([])
		expect(state.initialIds).toEqual({})
		expect(state.inputRefs).toEqual({})
	})

	it("setParsed accepts a value", () => {
		const store = createChecklistStore()

		store.getState().setParsed(live)

		expect(store.getState().parsed).toEqual(live)
	})

	it("setParsed accepts an updater fn reading the current state", () => {
		const store = createChecklistStore()

		store.getState().setParsed(live)
		store.getState().setParsed(prev => prev.map(i => ({ ...i, checked: true })))

		expect(store.getState().parsed.every(i => i.checked)).toBe(true)
	})

	it("setIds accepts a value and an updater fn", () => {
		const store = createChecklistStore()

		store.getState().setIds(["a", "b"])
		store.getState().setIds(prev => [...prev, "c"])

		expect(store.getState().ids).toEqual(["a", "b", "c"])
	})

	it("setInitialIds accepts a value and an updater fn", () => {
		const store = createChecklistStore()

		store.getState().setInitialIds({ a: true })
		store.getState().setInitialIds(prev => ({ ...prev, b: true }))

		expect(store.getState().initialIds).toEqual({ a: true, b: true })
	})

	it("setInputRefs accepts a value and an updater fn", () => {
		const store = createChecklistStore()
		const refA = { current: null }
		const refB = { current: null }

		store.getState().setInputRefs({ a: refA })
		store.getState().setInputRefs(prev => ({ ...prev, b: refB }))

		expect(store.getState().inputRefs).toEqual({ a: refA, b: refB })
	})

	// The core of finding #3: two mounted editors (a live note + a history "View" of the same uuid)
	// each create their OWN store, so hydrating one must NOT clobber the other.
	it("two store instances are fully independent (history view does not overwrite the live note)", () => {
		const liveStore = createChecklistStore()
		const historyStore = createChecklistStore()

		liveStore.getState().setParsed(live)
		liveStore.getState().setIds(live.map(i => i.id))

		// Hydrating the history editor (as its initialValue useEffect would) must not touch the live store.
		historyStore.getState().setParsed(history)
		historyStore.getState().setIds(history.map(i => i.id))

		expect(liveStore.getState().parsed).toEqual(live)
		expect(liveStore.getState().ids).toEqual(["live-1", "live-2"])
		expect(historyStore.getState().parsed).toEqual(history)
		expect(historyStore.getState().ids).toEqual(["history-1"])
	})

	it("input refs are not shared across instances", () => {
		const a = createChecklistStore()
		const b = createChecklistStore()
		const ref = { current: null }

		a.getState().setInputRefs({ shared: ref })

		expect(b.getState().inputRefs).toEqual({})
		expect(a.getState().inputRefs).toEqual({ shared: ref })
	})

	it("a mutation after subscribe notifies only its own subscribers", () => {
		const a = createChecklistStore()
		const b = createChecklistStore()
		let aNotified = 0
		let bNotified = 0
		const unsubA = a.subscribe(() => {
			aNotified++
		})
		const unsubB = b.subscribe(() => {
			bNotified++
		})

		a.getState().setParsed(live)

		expect(aNotified).toBe(1)
		expect(bNotified).toBe(0)

		unsubA()
		unsubB()
	})
})
