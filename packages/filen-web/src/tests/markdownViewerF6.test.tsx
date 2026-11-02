// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { DriveItem } from "@/features/drive/lib/item"
import { MarkdownViewer } from "@/features/preview/components/markdownViewer"
import { registerAllActions } from "@/lib/keymap/actions"
import { createTestQueryClient, queryClientWrapper } from "@/tests/testQueryClient"
import "@/lib/i18n"

// The Markdown viewer's F6 pressed outside it (focus on the preview overlay itself, where Safari and macOS Firefox
// leave it after a click) goes to its command bar, as one pressed in it does.

vi.mock("@/features/preview/hooks/usePreviewBytes", () => ({
	usePreviewBytes: () => ({ status: "success", bytes: new TextEncoder().encode("# Title\n\nText.") })
}))

registerAllActions()

afterEach(() => {
	cleanup()
})

describe("the Markdown viewer", () => {
	it("goes to the command bar with F6 pressed outside the viewer", async () => {
		render(
			<MarkdownViewer
				item={{ uuid: "md", name: "notes.md" } as unknown as DriveItem}
				alt="notes.md"
			/>,
			{ wrapper: queryClientWrapper(createTestQueryClient()) }
		)
		await screen.findByRole("document")

		fireEvent.keyDown(document.body, { key: "F6" })
		expect(document.activeElement?.closest("[data-office-ribbon]")).not.toBeNull()
	})
})
