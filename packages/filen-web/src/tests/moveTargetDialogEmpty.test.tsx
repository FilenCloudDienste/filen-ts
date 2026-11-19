// @vitest-environment jsdom

// The move/copy picker over a directory that holds files only: a good destination with content, so it says there
// are no directories rather than that the directory is empty.
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { createElement } from "react"
import { QueryClient } from "@tanstack/react-query"
import type { File as SdkFile, UuidStr } from "@filen/sdk-rs"
import "@/lib/i18n"

const picker = vi.hoisted(() => ({ items: [] as unknown[] }))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))
vi.mock("@/features/drive/hooks/useDirectoryPicker", () => ({
	useDirectoryPicker: () => ({
		pathStack: [DOCS],
		targetUuid: DOCS,
		listingQuery: { status: "success", data: picker.items },
		items: picker.items,
		namesQuery: { data: { [DOCS]: "Docs" } },
		descend: vi.fn(),
		goRoot: vi.fn(),
		goTo: vi.fn()
	}),
	useDirectoryPickerFilter: () => ["", vi.fn()]
}))
vi.mock("@/features/drive/components/newDirectory", () => ({ NewDirectoryDialog: () => null }))

import { narrowItem } from "@/features/drive/lib/item"
import { MoveTargetDialog } from "@/features/drive/components/moveTargetDialog"

const DOCS = "docs-0000-0000-0000-000000000000"

function file(name: string) {
	return narrowItem({
		uuid: `${name}-0000-0000-0000-000000000000` as UuidStr,
		stableUUID: undefined,
		parent: DOCS as UuidStr,
		size: 1n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name, mime: "text/plain", modified: 0n, size: 1n, key: "key", version: 2 } }
	} satisfies SdkFile)
}

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})

describe("MoveTargetDialog empty states", () => {
	it("says no directories for a directory holding files only", () => {
		picker.items = [file("a.txt"), file("b.txt")]

		render(
			createElement(MoveTargetDialog, {
				mode: "pick",
				items: [],
				pickLabels: { title: "Save to", confirm: "Save here" },
				onPick: vi.fn(),
				onClose: vi.fn()
			})
		)

		expect(screen.getByText("No directories")).toBeTruthy()
		expect(screen.queryByTestId("listing-empty")).toBeNull()
	})

	it("keeps the empty-directory state for a directory with nothing in it", () => {
		picker.items = []

		render(
			createElement(MoveTargetDialog, {
				mode: "pick",
				items: [],
				pickLabels: { title: "Save to", confirm: "Save here" },
				onPick: vi.fn(),
				onClose: vi.fn()
			})
		)

		expect(screen.getByTestId("listing-empty")).toBeTruthy()
		expect(screen.queryByText("No directories")).toBeNull()
	})
})
