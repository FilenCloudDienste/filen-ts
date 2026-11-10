import { describe, expect, it } from "vitest"
import { availableOn, defaultComboOn } from "@/lib/keymap/registry"
import { SYNC_ACTIONS } from "@/features/sync/lib/keymap"

const MAC = { mac: true, desktop: true }
const OTHER = { mac: false, desktop: true }

function def(id: string) {
	const found = SYNC_ACTIONS.find(action => action.id === id)

	if (found === undefined) {
		throw new Error(`no ${id}`)
	}

	return found
}

describe("SYNC_ACTIONS", () => {
	it("are all sync-scoped", () => {
		for (const action of SYNC_ACTIONS) expect(action.scope, action.id).toBe("sync")
	})

	it("exist in the desktop app only", () => {
		for (const action of SYNC_ACTIONS) {
			expect(availableOn(action, OTHER), action.id).toBe(true)
			expect(availableOn(action, MAC), action.id).toBe(true)
			expect(availableOn(action, { mac: false, desktop: false }), action.id).toBe(false)
			expect(availableOn(action, { mac: true, desktop: false }), action.id).toBe(false)
		}
	})

	it("ships the add, stepping, review and save defaults", () => {
		expect(defaultComboOn(def("sync.addPair"), OTHER)).toBe("n")
		expect(defaultComboOn(def("sync.previousPair"), OTHER)).toBe("alt+arrowup")
		expect(defaultComboOn(def("sync.nextPair"), OTHER)).toBe("alt+arrowdown")
		expect(defaultComboOn(def("sync.startReview"), OTHER)).toBe("mod+enter")
		expect(defaultComboOn(def("sync.saveIgnoreRules"), OTHER)).toBe("mod+s")
	})

	// A Mac laptop has no Delete key: Finder's Cmd+Backspace is added there.
	it("removes a pair with Delete, and also Cmd+Backspace on a Mac", () => {
		expect(defaultComboOn(def("sync.removePair"), OTHER)).toBe("delete")
		expect(defaultComboOn(def("sync.removePair"), MAC)).toBe("delete,mod+backspace")
	})

	// Mod+R reloads the page and Mod+1…4 are taken, so these wait for the user to bind them.
	it("leaves pause, sync now and the tabs unset", () => {
		for (const id of [
			"sync.togglePause",
			"sync.syncNow",
			"sync.tabActivity",
			"sync.tabIssues",
			"sync.tabIgnored",
			"sync.tabSettings"
		]) {
			expect(defaultComboOn(def(id), MAC), id).toBe("")
			expect(defaultComboOn(def(id), OTHER), id).toBe("")
		}
	})
})
