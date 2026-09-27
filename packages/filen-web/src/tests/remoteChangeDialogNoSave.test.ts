// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import "@/lib/i18n"
import { RemoteChangeDialog } from "@/features/preview/components/remoteChangeDialog"

// A read-only viewer has no save source: the dialog offers no save, says why, and still lets the user
// keep the edits on screen (closing then asks through the unsaved-changes prompt).
function dialog(kind: "revised" | "deleted", onKeepMine: () => void) {
	return createElement(RemoteChangeDialog, {
		kind,
		title: "title",
		body: "body",
		readMine: () => undefined,
		pending: false,
		onKeepMine,
		onLoadTheirs: vi.fn(),
		onDiscardMine: vi.fn()
	})
}

afterEach(() => {
	cleanup()
})

describe("RemoteChangeDialog without a save source", () => {
	it("offers keeping the edits of a deleted file instead of saving them", () => {
		const onKeepMine = vi.fn()

		render(dialog("deleted", onKeepMine))

		expect(screen.queryByRole("button", { name: "Save as new file" })).toBeNull()
		expect(screen.getByText(/can't be saved from this preview/)).toBeDefined()

		fireEvent.click(screen.getByRole("button", { name: "Keep on screen" }))

		expect(onKeepMine).toHaveBeenCalledOnce()
	})

	it("offers no copy of edits over a newer version", () => {
		render(dialog("revised", vi.fn()))

		expect(screen.queryByRole("button", { name: "Save mine as copy" })).toBeNull()
		expect(screen.getByRole("button", { name: "Keep mine" })).toBeDefined()
	})
})
