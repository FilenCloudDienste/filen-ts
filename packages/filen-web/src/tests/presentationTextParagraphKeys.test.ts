import { APPLE_TEXT_BINDINGS, DEFAULT_TEXT_BINDINGS } from "@filen/office/react/presentation"
import { afterEach, describe, expect, it, vi } from "vitest"

// The paragraph keys of the presentation text editor as the app's keymap defaults them: PowerPoint's per platform,
// the same as the editor's own (Alt+Shift+arrows and Ctrl+Enter on Windows, Cmd+[ and Cmd+] on a Mac).

const COMMANDS = ["promote", "demote", "moveParagraphUp", "moveParagraphDown", "nextPlaceholder"] as const

async function bindingsOn(userAgent: string) {
	vi.resetModules()
	vi.stubGlobal("navigator", { userAgent })

	const { presentationTextBindings } = await import("@/features/presentation/lib/keymap/text")

	return presentationTextBindings({})
}

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("presentation paragraph key defaults", () => {
	it("are Windows' PowerPoint keys off a Mac", async () => {
		const bindings = await bindingsOn("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")

		for (const command of COMMANDS) expect(bindings[command], command).toBe(DEFAULT_TEXT_BINDINGS[command])
		expect(bindings.promote).toBe("alt+shift+left")
		expect(bindings.nextPlaceholder).toBe("mod+enter")
	})

	it("are the Mac's on a Mac", async () => {
		const bindings = await bindingsOn("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)")

		for (const command of COMMANDS) expect(bindings[command], command).toBe(APPLE_TEXT_BINDINGS[command])
		expect(bindings.demote).toBe("mod+]")
		expect(bindings.moveParagraphUp).toBe("")
	})

	it("take a user's override", async () => {
		vi.resetModules()

		const { presentationTextBindings } = await import("@/features/presentation/lib/keymap/text")

		expect(presentationTextBindings({ "presentation.text.promote": "mod+shift+left" }).promote).toBe("mod+shift+left")
	})
})
