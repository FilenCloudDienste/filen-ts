// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { cleanup, render, screen } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"
import type { File, UuidStr } from "@filen/sdk-rs"

// "Open as text" shows a file nothing recognises in the text viewer, view-only: saving a binary file back
// as text would corrupt it.

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))
vi.mock("@tanstack/react-router", () => ({
	useBlocker: () => ({ status: "idle" }),
	useNavigate: () => vi.fn(),
	useRouterState: () => "/drive"
}))
vi.mock("@/lib/keymap/useAction", () => ({ useAction: vi.fn(), IN_EDITORS: {}, IN_EDITORS_AND_FIELDS: {} }))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))
vi.mock("@/features/preview/components/textViewer", () => ({
	TextViewer: ({ editable, rejectBinary }: { editable?: boolean; rejectBinary?: boolean }) =>
		createElement("div", {
			"data-testid": "text",
			"data-editable": String(editable === true),
			"data-reject-binary": String(rejectBinary === true)
		})
}))

import "@/lib/i18n"
import { narrowItem } from "@/features/drive/lib/item"
import { usePreviewUnsavedGuardStore } from "@/features/preview/store/usePreviewUnsavedGuard"
import { PreviewOverlay } from "@/features/preview/components/previewOverlay"

function named(name: string) {
	return narrowItem({
		uuid: "file-0000-0000-0000-000000000000",
		stableUUID: "lineage" as File["stableUUID"],
		parent: "parent-0000-0000-0000-000000000000" as UuidStr,
		size: 1n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name, mime: "application/octet-stream", modified: 0n, size: 1n, key: "k", version: 2 } }
	})
}

function overlay(name: string, asText: boolean) {
	return createElement(PreviewOverlay, {
		variant: "drive",
		items: [named(name)],
		index: 0,
		onStep: vi.fn(),
		onClose: vi.fn(),
		onItemRemoved: vi.fn(),
		asText
	})
}

afterEach(() => {
	cleanup()
	usePreviewUnsavedGuardStore.setState({ dirty: false, logoutRequest: null })
})

describe("PreviewOverlay — opened as text", () => {
	it("shows a file of an unknown type in the text viewer, read-only and guarded against binary content", async () => {
		render(overlay("settings.cfg", true))

		const viewer = await screen.findByTestId("text")

		expect(viewer.dataset["editable"]).toBe("false")
		expect(viewer.dataset["rejectBinary"]).toBe("true")

		usePreviewUnsavedGuardStore.setState({ dirty: true })

		expect(screen.queryByRole("button", { name: "Save" })).toBeNull()
	})

	it("has nothing to page to", async () => {
		render(overlay("settings.cfg", true))
		await screen.findByTestId("text")

		expect(screen.getByRole("button", { name: "Previous file" })).toHaveProperty("disabled", true)
		expect(screen.getByRole("button", { name: "Next file" })).toHaveProperty("disabled", true)
	})

	it("stays read-only after a rename to a text name", async () => {
		const { rerender } = render(overlay("settings.cfg", true))
		const viewer = await screen.findByTestId("text")

		rerender(overlay("settings.txt", true))

		expect(screen.getByTestId("text")).toBe(viewer)
		expect(viewer.dataset["editable"]).toBe("false")
	})

	it("keeps a real text file editable and unguarded when opened normally", async () => {
		render(overlay("notes.txt", false))

		const viewer = await screen.findByTestId("text")

		expect(viewer.dataset["editable"]).toBe("true")
		expect(viewer.dataset["rejectBinary"]).toBe("false")
	})
})
