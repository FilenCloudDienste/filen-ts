import { afterEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_SHOW_BINDINGS, DEFAULT_TEXT_BINDINGS } from "@filen/office/react/presentation"
import { PRESENTATION_OBJECT_ACTIONS, presentationObjectBindings } from "@/features/presentation/lib/keymap/objects"
import { PRESENTATION_SHOW_ACTIONS, presentationShowBindings } from "@/features/presentation/lib/keymap/show"
import { presentationTextBindings } from "@/features/presentation/lib/keymap/text"

// The presentation keys the shortcuts catalog lists beside the editor's own: duplicating objects apart from slides,
// the show's highlighter and presenter view (with PowerPoint for Mac's start keys), and a body's undo and redo
// following the editor's.

afterEach(() => {
	vi.unstubAllGlobals()
})

async function showBindingsOn(userAgent: string) {
	vi.resetModules()
	vi.stubGlobal("navigator", { userAgent })

	const show = await import("@/features/presentation/lib/keymap/show")

	return show.presentationShowBindings({})
}

describe("presentation object duplicate", () => {
	it("is its own action on Mod+D, apart from the slide list's", () => {
		expect(PRESENTATION_OBJECT_ACTIONS.find(action => action.id === "presentation.objects.duplicate")?.defaultCombo).toBe("mod+d")
		expect(presentationObjectBindings().duplicate).toBe("mod+d")
	})

	it("takes a user's override, unbound included", () => {
		expect(
			presentationObjectBindings((id, fallback) => (id === "presentation.objects.duplicate" ? "mod+alt+d" : fallback)).duplicate
		).toBe("mod+alt+d")
		expect(presentationObjectBindings((id, fallback) => (id === "presentation.objects.duplicate" ? "" : fallback)).duplicate).toBe("")
	})

	it("restacks on the Selection Pane's PowerPoint keys too", () => {
		const bindings = presentationObjectBindings()

		expect(bindings.bringForward).toBe("mod+bracketright,mod+shift+f")
		expect(bindings.sendBackward).toBe("mod+bracketleft,mod+shift+b")
	})
})

describe("presentation show keys", () => {
	it("register the highlighter and the presenter view with the show's own defaults", () => {
		const bindings = presentationShowBindings({})

		expect(bindings.highlighter).toBe("mod+i")
		expect(bindings.presenterView).toBe("alt+f5")
		expect(bindings.highlighter).toBe(DEFAULT_SHOW_BINDINGS.highlighter)
		expect(bindings.presenterView).toBe(DEFAULT_SHOW_BINDINGS.presenterView)
		expect(PRESENTATION_SHOW_ACTIONS.find(action => action.id === "presentation.show.presenterView")?.hintKey).toBe(
			"settings:keyboardHintPresentationEditor"
		)
	})

	it("start with PowerPoint for Mac's keys on a Mac, a clicker's F5 kept", async () => {
		const bindings = await showBindingsOn("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)")

		expect(bindings.start).toBe("f5,mod+shift+enter")
		expect(bindings.startCurrent).toBe("shift+f5,mod+enter")
		expect(bindings.presenterView).toBe("alt+f5,alt+enter")
	})

	it("start with F5 alone off a Mac", async () => {
		const bindings = await showBindingsOn("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")

		expect(bindings.start).toBe("f5")
		expect(bindings.startCurrent).toBe("shift+f5")
		expect(bindings.presenterView).toBe("alt+f5")
	})

	it("take a user's override, an unbound key included, with nothing of the default left", () => {
		const bindings = presentationShowBindings({ "presentation.show.highlighter": "", "presentation.show.next": "arrowright" })

		expect(bindings.highlighter).toBe("")
		expect(bindings.next).toBe("arrowright")
	})
})

describe("presentation text undo and redo", () => {
	it("are the editor's undo and redo", () => {
		const bindings = presentationTextBindings({})

		expect(bindings.undo).toBe("mod+z")
		expect(bindings.redo).toBe("mod+y,mod+shift+z")
		expect(bindings.undo).toBe(DEFAULT_TEXT_BINDINGS.undo)
		expect(bindings.redo).toBe(DEFAULT_TEXT_BINDINGS.redo)
	})

	it("follow a user's override of the editor's actions", () => {
		const bindings = presentationTextBindings({ "presentation.undo": "mod+alt+z", "presentation.redo": "" })

		expect(bindings.undo).toBe("mod+alt+z")
		expect(bindings.redo).toBe("")
	})
})
