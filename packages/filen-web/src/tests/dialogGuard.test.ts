import { afterEach, describe, expect, it, vi } from "vitest"

// dialogGuard.ts reads via a single `document.querySelector(...)` call against a fixed, hardcoded
// attribute-selector string — no DOM lib (happy-dom is not a project dependency, mirrors
// register.test.ts's own rationale) is needed for that, a minimal fake `querySelector` that
// understands comma-separated groups of `[attr]`/`[attr="value"]` conditions (exactly the shape
// dialogGuard.ts's own selector uses) is enough to drive every case below against a plain list of
// fake elements.
interface FakeElement {
	role?: string
	dataOpen?: boolean
}

const ATTR_PATTERN = /\[([a-zA-Z-]+)(?:="([^"]*)")?\]/g

function elementMatchesGroup(element: FakeElement, group: string): boolean {
	const conditions = Array.from(group.matchAll(ATTR_PATTERN))

	return conditions.every(([, attr, value]) => {
		if (attr === "role") {
			return value === undefined || element.role === value
		}

		if (attr === "data-open") {
			return element.dataOpen === true
		}

		return false
	})
}

function fakeDocument(elements: FakeElement[]) {
	return {
		querySelector: (selector: string) => {
			const groups = selector.split(",").map(group => group.trim())
			const match = elements.some(element => groups.some(group => elementMatchesGroup(element, group)))

			return match ? {} : null
		}
	}
}

afterEach(() => {
	vi.unstubAllGlobals()
	vi.resetModules()
})

describe("isAnyDialogOpen", () => {
	it("is false with no open-dialog element in the DOM", async () => {
		vi.stubGlobal("document", fakeDocument([]))

		const { isAnyDialogOpen } = await import("@/lib/keymap/dialogGuard")

		expect(isAnyDialogOpen()).toBe(false)
	})

	it('is true while a role="dialog" popup carries data-open (Dialog — InputDialog/MoveTargetDialog/PreviewOverlay/…)', async () => {
		vi.stubGlobal("document", fakeDocument([{ role: "dialog", dataOpen: true }]))

		const { isAnyDialogOpen } = await import("@/lib/keymap/dialogGuard")

		expect(isAnyDialogOpen()).toBe(true)
	})

	it('is true while a role="alertdialog" popup carries data-open (AlertDialog — ConfirmDialog/TypedConfirmDialog)', async () => {
		vi.stubGlobal("document", fakeDocument([{ role: "alertdialog", dataOpen: true }]))

		const { isAnyDialogOpen } = await import("@/lib/keymap/dialogGuard")

		expect(isAnyDialogOpen()).toBe(true)
	})

	it("is false for a dialog-role element that is present but not open (no data-open — mid-close-transition)", async () => {
		vi.stubGlobal("document", fakeDocument([{ role: "dialog", dataOpen: false }]))

		const { isAnyDialogOpen } = await import("@/lib/keymap/dialogGuard")

		expect(isAnyDialogOpen()).toBe(false)
	})

	it("ignores an unrelated open popup role (e.g. a menu/tooltip is not a dialog)", async () => {
		vi.stubGlobal("document", fakeDocument([{ role: "menu", dataOpen: true }]))

		const { isAnyDialogOpen } = await import("@/lib/keymap/dialogGuard")

		expect(isAnyDialogOpen()).toBe(false)
	})
})
