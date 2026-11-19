// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { PaneToggles } from "@/features/presentation/components/slideControls"
import { PresentationEditorContext, type PresentationEditorScope } from "@/features/presentation/hooks/usePresentationSession"
import "@/lib/i18n"

// The View tab's pane toggles: the rail keeps one name and is pressed while open; notes are named by what a press does
// (Show / Hide), so they carry no pressed state that would contradict it, only the look of one.

function mount(notesOpen: boolean): void {
	const scope = {
		editor: { document: { slides: [1] } },
		view: { railOpen: true, notesOpen, toggleRail: () => undefined, toggleNotes: () => undefined }
	} as unknown as PresentationEditorScope

	render(
		<PresentationEditorContext value={scope}>
			<PaneToggles />
		</PresentationEditorContext>
	)
}

afterEach(() => {
	cleanup()
})

describe("the presentation pane toggles", () => {
	it("names the notes toggle by what a press does, with no aria-pressed, highlighted while the notes are open", () => {
		mount(true)

		const hide = screen.getByRole("button", { name: "Hide notes" })

		expect(hide.hasAttribute("aria-pressed")).toBe(false)
		expect(hide.className).toContain("bg-accent")
		expect(screen.getByRole("button", { name: "Slide list" }).getAttribute("aria-pressed")).toBe("true")
		cleanup()

		mount(false)

		const show = screen.getByRole("button", { name: "Show notes" })

		expect(show.hasAttribute("aria-pressed")).toBe(false)
		expect(show.className).not.toContain("bg-accent")
	})
})
