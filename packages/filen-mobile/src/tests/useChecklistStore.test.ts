import { describe, it, expect } from "vitest"
import { createChecklistStore } from "@/features/notes/store/useChecklist.store"
import { type Checklist } from "@filen/shared"

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
		expect(state.byId.size).toBe(0)
		expect(state.inputRefs.size).toBe(0)
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

	it("byId mirrors parsed after setParsed with a value and with an updater", () => {
		const store = createChecklistStore()

		store.getState().setParsed(live)

		for (const item of live) {
			expect(store.getState().byId.get(item.id)).toBe(item)
		}

		store.getState().setParsed(prev => prev.filter(i => i.id !== "live-1"))

		const { parsed, byId } = store.getState()

		expect(byId.size).toBe(1)
		expect(byId.get("live-1")).toBeUndefined()
		expect(byId.get("live-2")).toBe(parsed[0])
	})

	it("byId returns the same item Array.prototype.find would, even for duplicate ids", () => {
		const store = createChecklistStore()
		const dupes: Checklist = [
			{ id: "dup", checked: false, content: "first" },
			{ id: "dup", checked: true, content: "second" }
		]

		store.getState().setParsed(dupes)

		const { parsed, byId } = store.getState()

		expect(byId.get("dup")).toBe(parsed.find(i => i.id === "dup"))
		expect(byId.get("missing")).toBe(parsed.find(i => i.id === "missing"))
	})

	it("inputRefs is mutated in place without notifying subscribers", () => {
		const store = createChecklistStore()
		const inputRefs = store.getState().inputRefs
		const ref = { current: null }
		let notified = 0
		const unsub = store.subscribe(() => {
			notified++
		})

		store.getState().inputRefs.set("a", ref)

		expect(store.getState().inputRefs.get("a")).toBe(ref)

		store.getState().setParsed(live)

		// setParsed must not replace the Map a mounted row registered into.
		expect(store.getState().inputRefs).toBe(inputRefs)
		expect(store.getState().inputRefs.get("a")).toBe(ref)

		store.getState().inputRefs.delete("a")

		expect(store.getState().inputRefs.size).toBe(0)
		expect(notified).toBe(1)

		unsub()
	})

	// The core of finding #3: two mounted editors (a live note + a history "View" of the same uuid)
	// each create their OWN store, so hydrating one must NOT clobber the other.
	it("two store instances are fully independent (history view does not overwrite the live note)", () => {
		const liveStore = createChecklistStore()
		const historyStore = createChecklistStore()

		liveStore.getState().setParsed(live)

		// Hydrating the history editor (as its initialValue useEffect would) must not touch the live store.
		historyStore.getState().setParsed(history)

		expect(liveStore.getState().parsed).toEqual(live)
		expect(historyStore.getState().parsed).toEqual(history)
	})

	it("input refs are not shared across instances", () => {
		const a = createChecklistStore()
		const b = createChecklistStore()
		const ref = { current: null }

		expect(a.getState().inputRefs).not.toBe(b.getState().inputRefs)

		a.getState().inputRefs.set("shared", ref)

		expect(b.getState().inputRefs.size).toBe(0)
		expect(a.getState().inputRefs.get("shared")).toBe(ref)
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
