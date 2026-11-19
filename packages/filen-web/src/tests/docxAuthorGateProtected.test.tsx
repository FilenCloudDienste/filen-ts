// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"
import { NO_REVIEW, type DocxRefusalReason } from "@filen/office/core/docx/edit"
import type { PagedEditor } from "@filen/office/core/docx/paged"
import "@/lib/i18n"

// An edit the editor refused because it would break what the document keeps (a section break, a locked block):
// told about in a toast once per burst, never with the author name prompt.

const settings = vi.hoisted(() => ({ asks: 0 }))
const toasts = vi.hoisted(() => ({ error: vi.fn() }))

vi.mock("sonner", () => ({ toast: toasts }))

vi.mock("@/features/office/lib/officeSettings", () => ({
	ensureAuthorName: (ask: () => Promise<string | null>) => {
		settings.asks++

		return ask()
	}
}))

const { useDocxAuthorGate } = await import("@/features/preview/components/docxAuthorGate")

function fakeEditor(): { editor: PagedEditor; refuse: (reason: DocxRefusalReason) => void } {
	const listeners = new Set<(reason: DocxRefusalReason) => void>()
	const editor = {
		onRefused: (listener: (reason: DocxRefusalReason) => void) => {
			listeners.add(listener)

			return () => {
				listeners.delete(listener)
			}
		},
		snapshot: () => ({ review: { ...NO_REVIEW, tracking: true, authorNeeded: true }, enabled: { "review.track": true } })
	} as unknown as PagedEditor

	return {
		editor,
		refuse: reason => {
			act(() => {
				for (const listener of listeners) listener(reason)
			})
		}
	}
}

function Gate({ editor }: { editor: PagedEditor }) {
	const { dialog } = useDocxAuthorGate({ authorName: null, editor, execute: () => undefined })

	return dialog
}

afterEach(() => {
	cleanup()
	vi.useRealTimers()
	toasts.error.mockReset()
	settings.asks = 0
})

describe("author name gate: protected edits", () => {
	it("tells about an edit refused as protected in a toast, once per burst, and asks no name for it", () => {
		vi.useFakeTimers({ toFake: ["Date"] })

		const { editor, refuse } = fakeEditor()

		render(<Gate editor={editor} />)

		refuse("protected")
		vi.advanceTimersByTime(500)
		refuse("protected")
		vi.advanceTimersByTime(1500)
		refuse("protected")

		expect(toasts.error).toHaveBeenCalledTimes(1)
		expect(toasts.error).toHaveBeenCalledWith("This part of the document can't be changed this way", {
			description:
				"It would change something kept as it is, such as a section break, a locked block, merged table cells, a form field or deleted text."
		})
		expect(settings.asks).toBe(0)
		expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull()

		// Another reason within the burst is told about too.
		refuse("unsupported")
		expect(toasts.error).toHaveBeenCalledTimes(2)
		expect(toasts.error).toHaveBeenLastCalledWith("This edit can't be made here", {
			description: "Part of what it changes can't be saved as a tracked change."
		})

		// After a quiet spell, a new burst.
		vi.advanceTimersByTime(2500)
		refuse("protected")
		expect(toasts.error).toHaveBeenCalledTimes(3)
		expect(settings.asks).toBe(0)
	})
})
