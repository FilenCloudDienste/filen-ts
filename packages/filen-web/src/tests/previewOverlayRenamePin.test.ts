// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, useEffect } from "react"
import { cleanup, render, screen } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"
import type { File, UuidStr } from "@filen/sdk-rs"

// A rename of the file on screen (from the header menu or another device) must never swap its viewer:
// the unsaved edits live in that viewer. A rename to another format leaves it read-only, offering no save.

const { mounts } = vi.hoisted(() => ({ mounts: { text: 0, spreadsheet: 0 } }))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))
vi.mock("@tanstack/react-router", () => ({
	useBlocker: () => ({ status: "idle" }),
	useNavigate: () => vi.fn(),
	useRouterState: () => "/drive"
}))
vi.mock("@/lib/keymap/useAction", () => ({ useAction: vi.fn(), IN_EDITORS: {}, IN_EDITORS_AND_FIELDS: {} }))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))

function viewerStub(kind: "text" | "spreadsheet") {
	return function Viewer({ editable }: { editable?: boolean }) {
		useEffect(() => {
			mounts[kind]++
		}, [])

		return createElement("div", { "data-testid": kind, "data-editable": String(editable === true) })
	}
}

vi.mock("@/features/preview/components/textViewer", () => ({ default: viewerStub("text") }))
vi.mock("@/features/spreadsheet/components/spreadsheetViewer", () => ({ default: viewerStub("spreadsheet") }))

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

function overlay(name: string) {
	return createElement(PreviewOverlay, {
		variant: "drive" as const,
		items: [{ type: "drive" as const, item: named(name) }],
		index: 0,
		onStep: vi.fn(),
		onClose: vi.fn(),
		onItemRemoved: vi.fn()
	})
}

beforeEach(() => {
	mounts.text = 0
	mounts.spreadsheet = 0
})

afterEach(() => {
	cleanup()
	usePreviewUnsavedGuardStore.setState({ dirty: false, logoutRequest: null })
})

describe("PreviewOverlay — a rename of the open file", () => {
	it.each([
		["notes.txt", "notes.bin", "text"],
		["budget.xlsx", "budget.xlsx.bak", "spreadsheet"],
		["budget.xlsx", "budget.txt", "spreadsheet"]
	] as const)("keeps %s's viewer and its edits when renamed to %s, and offers no save", async (from, to, kind) => {
		const { rerender } = render(overlay(from))
		const viewer = await screen.findByTestId(kind)

		expect(viewer.dataset["editable"]).toBe("true")

		usePreviewUnsavedGuardStore.setState({ dirty: true })
		await screen.findByRole("button", { name: "Save" })

		rerender(overlay(to))

		expect(screen.getByTestId(kind)).toBe(viewer)
		expect(mounts[kind]).toBe(1)
		expect(viewer.dataset["editable"]).toBe("false")
		expect(usePreviewUnsavedGuardStore.getState().dirty).toBe(true)
		expect(screen.queryByRole("button", { name: "Save" })).toBeNull()
	})

	it("stays editable across a rename that keeps the format", async () => {
		const { rerender } = render(overlay("notes.txt"))
		const viewer = await screen.findByTestId("text")

		rerender(overlay("renamed.md"))

		expect(screen.getByTestId("text")).toBe(viewer)
		expect(viewer.dataset["editable"]).toBe("true")
	})
})
