import { describe, expect, it } from "vitest"
import { presentationTextBindings } from "@/features/presentation/lib/keymap/text"

// The presentation text editor's keys as the app's keymap resolves them: each action's default, a user's override in
// its place, and the document editors' bold, italic and link actions for those keys.

describe("presentation text key bindings", () => {
	it("are each action's default without overrides", () => {
		const bindings = presentationTextBindings({})

		expect(bindings.bold).toBe("mod+b")
		expect(bindings.link).toBe("mod+k")
		expect(bindings.underline).toBe("mod+u")
		expect(bindings.lineBreak).toBe("shift+enter")
		expect(bindings.levelUp).toBe("shift+tab")
	})

	it("take a user's override, including the shared editor actions", () => {
		const bindings = presentationTextBindings({ "presentation.text.underline": "mod+shift+u", "editor.link": "mod+shift+k" })

		expect(bindings.underline).toBe("mod+shift+u")
		expect(bindings.link).toBe("mod+shift+k")
		expect(bindings.italic).toBe("mod+i")
	})
})
