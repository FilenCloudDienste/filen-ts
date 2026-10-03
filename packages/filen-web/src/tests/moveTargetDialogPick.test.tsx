// @vitest-environment jsdom

// Pick mode only reports the chosen directory, to a form that runs its job later (compress, extract).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import { QueryClient } from "@tanstack/react-query"
import type { Dir, UuidStr } from "@filen/sdk-rs"
import "@/lib/i18n"

const { moveItems, startCopyWithCard, pickerPaths, online, parents } = vi.hoisted(() => ({
	moveItems: vi.fn(),
	startCopyWithCard: vi.fn(),
	pickerPaths: [] as (readonly string[] | undefined)[],
	online: { current: true },
	parents: new Map<string, string | null>()
}))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => online.current }))
vi.mock("@/features/drive/lib/actions", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/lib/actions")>()),
	moveItems
}))
vi.mock("@/features/transfers/lib/copyToast", () => ({ startCopyWithCard }))
vi.mock("@/features/drive/lib/ownAncestry", () => ({ cachedOwnParents: () => (uuid: string) => parents.get(uuid) }))
// The picker opens in "docs", whose listing is empty; the path it was opened with is recorded.
vi.mock("@/features/drive/hooks/useDirectoryPicker", () => ({
	useDirectoryPicker: (initialPath?: readonly string[]) => {
		pickerPaths.push(initialPath)

		return {
			pathStack: [DOCS],
			targetUuid: DOCS,
			listingQuery: { status: "success", data: [] },
			items: [],
			namesQuery: { data: { [DOCS]: "Docs" } },
			descend: vi.fn(),
			goRoot: vi.fn(),
			goTo: vi.fn()
		}
	},
	useDirectoryPickerFilter: () => ["", vi.fn()]
}))
vi.mock("@/features/drive/components/newDirectory", () => ({ NewDirectoryDialog: () => null }))

import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { MoveTargetDialog } from "@/features/drive/components/moveTargetDialog"
import { DestinationField } from "@/features/drive/components/destinationField"

const DOCS = "docs-0000-0000-0000-000000000000"
const WORK = "work-0000-0000-0000-000000000000"
const LABELS = { title: "Save to", confirm: "Save here" }

function dir(uuid: string, name: string): DriveItem {
	return narrowItem({
		uuid: uuid as UuidStr,
		parent: "home-0000-0000-0000-000000000000" as UuidStr,
		color: "default",
		timestamp: 0n,
		favorited: false,
		meta: { type: "decoded", data: { name } }
	} satisfies Dir)
}

beforeEach(() => {
	online.current = true
	pickerPaths.length = 0
	parents.clear()
})

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})

describe("MoveTargetDialog picking", () => {
	it("reports the open directory under the caller's labels, then closes, starting nothing", () => {
		const onPick = vi.fn()
		const onClose = vi.fn()

		render(createElement(MoveTargetDialog, { mode: "pick", items: [], pickLabels: LABELS, onPick, onClose }))

		expect(screen.getByRole("heading", { name: "Save to" })).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "Save here" }))

		expect(onPick).toHaveBeenCalledExactlyOnceWith({ uuid: DOCS, name: "Docs" })
		expect(onClose).toHaveBeenCalledTimes(1)
		expect(moveItems).not.toHaveBeenCalled()
		expect(startCopyWithCard).not.toHaveBeenCalled()
	})

	it("won't pick a directory inside one of the sources", () => {
		render(
			createElement(MoveTargetDialog, {
				mode: "pick",
				items: [dir(DOCS, "Docs")],
				pickLabels: LABELS,
				onPick: vi.fn(),
				onClose: vi.fn()
			})
		)

		expect(screen.getByRole("button", { name: "Save here" })).toHaveProperty("disabled", true)
	})

	it("picks offline too, since it writes nothing", () => {
		online.current = false

		render(createElement(MoveTargetDialog, { mode: "pick", items: [], pickLabels: LABELS, onPick: vi.fn(), onClose: vi.fn() }))

		expect(screen.getByRole("button", { name: "Save here" })).toHaveProperty("disabled", false)
		expect(screen.getByRole("button", { name: "New directory" })).toHaveProperty("disabled", true)
	})

	it("won't pick offline when the pick itself starts the work", () => {
		online.current = false

		render(
			createElement(MoveTargetDialog, {
				mode: "pick",
				items: [],
				pickLabels: LABELS,
				startsWork: true,
				onPick: vi.fn(),
				onClose: vi.fn()
			})
		)

		expect(screen.getByRole("button", { name: "Save here" })).toHaveProperty("disabled", true)
	})
})

describe("DestinationField", () => {
	it("opens the picker at the destination's cached chain and takes the pick", () => {
		parents.set(DOCS, WORK)
		parents.set(WORK, null)

		const onChange = vi.fn()

		render(
			createElement(DestinationField, {
				label: "Save in",
				destination: { uuid: DOCS, name: "Docs" },
				onChange,
				sources: [],
				pickLabels: LABELS
			})
		)

		expect(screen.getByText("Docs")).toBeTruthy()
		expect(screen.getByRole("group", { name: "Save in" })).toBeTruthy()
		expect(pickerPaths).toEqual([])

		fireEvent.click(screen.getByRole("button", { name: "Change…" }))

		expect(pickerPaths[0]).toEqual([WORK, DOCS])

		fireEvent.click(screen.getByRole("button", { name: "Save here" }))

		expect(onChange).toHaveBeenCalledExactlyOnceWith({ uuid: DOCS, name: "Docs" })
		expect(screen.queryByRole("dialog")).toBeNull()
	})

	it("opens at the root when the chain isn't cached, and names the root", () => {
		render(
			createElement(DestinationField, {
				label: "Save in",
				destination: { uuid: null, name: "ignored" },
				onChange: vi.fn(),
				sources: [],
				pickLabels: LABELS
			})
		)

		expect(screen.getByText("Cloud Drive")).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "Change…" }))

		expect(pickerPaths[0]).toEqual([])
	})

	it("falls back to the root for a chain with a missing link", () => {
		parents.set(DOCS, WORK)

		render(
			createElement(DestinationField, {
				label: "Save in",
				destination: { uuid: DOCS, name: "Docs" },
				onChange: vi.fn(),
				sources: [],
				pickLabels: LABELS
			})
		)
		fireEvent.click(screen.getByRole("button", { name: "Change…" }))

		expect(pickerPaths[0]).toEqual([])
	})
})
