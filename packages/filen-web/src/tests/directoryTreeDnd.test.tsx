// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import { QueryClient, type UseQueryResult } from "@tanstack/react-query"
import type { Dir, UuidStr } from "@filen/sdk-rs"

const { performMove, startCopyWithCard } = vi.hoisted(() => ({ performMove: vi.fn(), startCopyWithCard: vi.fn() }))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("@/features/drive/lib/dnd", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/lib/dnd")>()),
	performMove
}))
vi.mock("@/features/transfers/lib/copyToast", () => ({ startCopyWithCard }))

import "@/lib/i18n"
import { queryClient } from "@/queries/client"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { INTERNAL_DRAG_TYPE, clearDragPayload, getDragPayload } from "@/features/drive/lib/dnd"
import { driveListingQueryKey, projectTreeChildren, type DirectoryTreeChild } from "@/features/drive/queries/drive"
import { DirectoryTree, type DirectoryTreeContext } from "@/features/drive/components/directoryTree"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function dirItem(label: string, name: string, parent: string): DriveItem {
	return narrowItem({
		uuid: testUuid(label),
		parent: parent as UuidStr,
		color: "default",
		timestamp: 0n,
		favorited: false,
		meta: { type: "decoded", data: { name } }
	} satisfies Dir)
}

// root > docs > inner, and photos beside docs.
const DOCS = dirItem("docs", "Docs", testUuid("root"))
const PHOTOS = dirItem("photos", "Photos", testUuid("root"))
const INNER = dirItem("inner", "Inner", testUuid("docs"))

const LISTINGS = new Map<string | null, DriveItem[]>([
	[null, [DOCS, PHOTOS]],
	[testUuid("docs"), [INNER]]
])

// One transfer threaded through a whole drag, as the browser does; jsdom has none of its own.
function dataTransfer() {
	const types: string[] = []

	return {
		types,
		effectAllowed: "none",
		dropEffect: "none",
		setData: (type: string) => {
			types.push(type)
		},
		setDragImage: () => undefined
	}
}

type Transfer = ReturnType<typeof dataTransfer>

// jsdom has no DragEvent, so the copy modifier is set on the plain event it builds. Off macOS (jsdom's
// platform) that modifier is Ctrl.
function drag(
	type: "dragStart" | "dragEnter" | "dragOver" | "drop" | "dragEnd",
	element: Element,
	transfer: Transfer,
	copy = false
): Event {
	const event = createEvent[type](element, { dataTransfer: transfer })

	Object.defineProperty(event, "ctrlKey", { value: copy })
	Object.defineProperty(event, "altKey", { value: false })
	fireEvent(element, event)

	return event
}

function row(name: string): Element {
	const found = screen.getByRole("button", { name }).closest("[data-tree-path]")

	if (found === null) {
		throw new Error(`no tree row for "${name}"`)
	}

	return found
}

function renderTree(onToggle: (uuid: string) => void = () => undefined) {
	const tree: DirectoryTreeContext = {
		activePath: [],
		isOpen: uuid => uuid === testUuid("docs"),
		onToggle,
		onNavigate: () => undefined,
		useChildren: uuid =>
			({ status: "success", data: projectTreeChildren(LISTINGS.get(uuid) ?? []) }) as UseQueryResult<DirectoryTreeChild[]>,
		enableDrop: true,
		enableDrag: true
	}

	return render(createElement(DirectoryTree, { tree }))
}

// Starts dragging a node, returning the transfer the rest of the drag rides on.
function startDrag(name: string): Transfer {
	const transfer = dataTransfer()

	drag("dragStart", row(name), transfer)

	return transfer
}

beforeEach(() => {
	// jsdom has no 2D canvas; the drag image is drawn only where there is one.
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null)

	for (const [uuid, items] of LISTINGS) {
		queryClient.setQueryData(driveListingQueryKey({ variant: "drive", uuid }), items)
	}
})

afterEach(() => {
	clearDragPayload()
	cleanup()
	vi.useRealTimers()
})

describe("sidebar tree drag and drop", () => {
	it("drags a node's own directory as an internal drag, and lets go of it on dragend", () => {
		renderTree()
		const inner = row("Inner")

		expect(inner.getAttribute("draggable")).toBe("true")

		const transfer = startDrag("Inner")

		expect(transfer.types).toEqual([INTERNAL_DRAG_TYPE])
		expect(transfer.effectAllowed).toBe("copyMove")
		expect(getDragPayload()).toEqual([INNER])

		drag("dragEnd", inner, transfer)
		expect(getDragPayload()).toEqual([])
	})

	it("moves a node onto another on a plain drop", () => {
		renderTree()
		const transfer = startDrag("Inner")
		const photos = row("Photos")

		expect(drag("dragOver", photos, transfer).defaultPrevented).toBe(true)
		drag("drop", photos, transfer)

		expect(performMove).toHaveBeenCalledExactlyOnceWith([INNER], testUuid("photos"))
		expect(startCopyWithCard).not.toHaveBeenCalled()
	})

	it("refuses a directory dropped into itself or below it, in either mode", () => {
		renderTree()
		const transfer = startDrag("Docs")

		for (const target of [row("Docs"), row("Inner")]) {
			expect(drag("dragOver", target, transfer).defaultPrevented).toBe(false)
			expect(drag("dragOver", target, transfer, true).defaultPrevented).toBe(false)
			drag("drop", target, transfer)
		}

		expect(performMove).not.toHaveBeenCalled()
	})

	it("copies with the copy modifier held, even back into the node's own parent, where a move is a no-op", () => {
		renderTree()
		const transfer = startDrag("Inner")
		const docs = row("Docs")

		expect(drag("dragOver", docs, transfer).defaultPrevented).toBe(false)
		expect(drag("dragOver", docs, transfer, true).defaultPrevented).toBe(true)
		drag("drop", docs, transfer, true)

		expect(startCopyWithCard).toHaveBeenCalledExactlyOnceWith([INNER], { uuid: testUuid("docs"), name: "Docs" })
		expect(performMove).not.toHaveBeenCalled()
	})

	it("expands a collapsed node the drag dwells on, and not one it can't drop into", () => {
		vi.useFakeTimers()
		const onToggle = vi.fn()
		renderTree(onToggle)
		const transfer = startDrag("Docs")

		// Inner sits below the dragged directory: no dwell.
		drag("dragEnter", row("Inner"), transfer)
		drag("dragEnter", row("Photos"), transfer)

		act(() => {
			vi.advanceTimersByTime(699)
		})
		expect(onToggle).not.toHaveBeenCalled()

		act(() => {
			vi.advanceTimersByTime(1)
		})
		expect(onToggle).toHaveBeenCalledExactlyOnceWith(testUuid("photos"), null)
	})

	it("carries the node's root-to-node chain for the tree's menu and shortcuts", () => {
		renderTree()

		expect(row("Inner").getAttribute("data-tree-path")).toBe(`${testUuid("docs")}/${testUuid("inner")}`)
		expect(row("Photos").getAttribute("data-tree-path")).toBe(testUuid("photos"))
	})
})
