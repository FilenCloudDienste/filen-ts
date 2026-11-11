// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"
import { createElement } from "react"
import { QueryClient, type UseQueryResult } from "@tanstack/react-query"
import type { Dir, UuidStr } from "@filen/sdk-rs"

const { performMove, startCopyWithCard } = vi.hoisted(() => ({ performMove: vi.fn(), startCopyWithCard: vi.fn() }))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("@/features/drive/lib/dnd", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/lib/dnd")>()),
	performMove
}))
vi.mock("@/features/transfers/lib/copyToast", () => ({ startCopyWithCard }))

import "@/lib/i18n"
import { queryClient } from "@/queries/client"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { clearDragPayload, getDragPayload } from "@/features/drive/lib/dnd"
import { driveListingQueryKey, projectTreeChildren, type DirectoryTreeChild } from "@/features/drive/queries/drive"
import { DirectoryTree, type DirectoryTreeContext } from "@/features/drive/components/directoryTree"
import { testUuid } from "@/tests/support/uuid"
import { endDrag, FAKE_FRAMES, FAKE_FRAMES_AND_TIMEOUTS, moveOver, pressOn, releaseOver, stubHitTest } from "@/tests/support/pointerDrag"

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

// A node's navigating button: what the pointer presses and rests on.
function button(name: string): HTMLElement {
	return screen.getByRole("button", { name })
}

function row(name: string): Element {
	const found = button(name).closest("[data-tree-path]")

	if (found === null) {
		throw new Error(`no tree row for "${name}"`)
	}

	return found
}

// The drop highlight's tint, a move's and a copy's alike.
function lit(name: string): boolean {
	return row(name).classList.contains("bg-primary/10")
}

function renderTree(onToggle: (uuid: string) => void = () => undefined) {
	const tree: DirectoryTreeContext = {
		activePath: [],
		isOpen: uuid => uuid === testUuid("docs"),
		onToggle,
		onNavigate: () => undefined,
		useChildren: uuid =>
			({ status: "success", data: projectTreeChildren(LISTINGS.get(uuid) ?? []) }) as UseQueryResult<DirectoryTreeChild[]>
	}

	return render(createElement(DirectoryTree, { tree }))
}

// Presses a node and moves past the drag threshold, over nothing yet.
function startDrag(name: string): void {
	pressOn(button(name))
	moveOver(null)
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: [...FAKE_FRAMES] })
	stubHitTest()
	// jsdom has no 2D canvas; the chip is drawn only where there is one.
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null)

	for (const [uuid, items] of LISTINGS) {
		queryClient.setQueryData(driveListingQueryKey({ variant: "drive", uuid }), items)
	}
})

afterEach(() => {
	endDrag()
	clearDragPayload()
	cleanup()
	vi.useRealTimers()
})

describe("sidebar tree drag and drop", () => {
	it("drags a node's own directory, and lets go of it when the drag ends", () => {
		renderTree()
		startDrag("Inner")

		expect(getDragPayload()).toEqual([INNER])

		releaseOver(null)
		expect(getDragPayload()).toEqual([])
	})

	it("moves a node onto another on a plain drop", () => {
		renderTree()
		startDrag("Inner")
		moveOver(button("Photos"))

		expect(lit("Photos")).toBe(true)
		releaseOver(button("Photos"))

		expect(performMove).toHaveBeenCalledExactlyOnceWith([INNER], { uuid: testUuid("photos"), name: "Photos" })
		expect(startCopyWithCard).not.toHaveBeenCalled()
	})

	it("refuses a directory dropped into itself or below it, in either mode", () => {
		renderTree()
		startDrag("Docs")

		for (const name of ["Docs", "Inner"]) {
			moveOver(button(name))
			expect(lit(name)).toBe(false)
			moveOver(button(name), true)
			expect(lit(name)).toBe(false)
		}

		releaseOver(button("Inner"))
		expect(performMove).not.toHaveBeenCalled()
		expect(startCopyWithCard).not.toHaveBeenCalled()
	})

	it("copies with the copy modifier held, even back into the node's own parent, where a move is a no-op", () => {
		renderTree()
		startDrag("Inner")

		moveOver(button("Docs"))
		expect(lit("Docs")).toBe(false)
		moveOver(button("Docs"), true)
		expect(lit("Docs")).toBe(true)
		releaseOver(button("Docs"), true)

		expect(startCopyWithCard).toHaveBeenCalledExactlyOnceWith([INNER], { uuid: testUuid("docs"), name: "Docs" })
		expect(performMove).not.toHaveBeenCalled()
	})

	it("expands a collapsed node the drag dwells on, and not one it can't drop into", () => {
		vi.useFakeTimers({ toFake: [...FAKE_FRAMES_AND_TIMEOUTS] })
		const onToggle = vi.fn()
		renderTree(onToggle)
		startDrag("Docs")

		// Inner sits below the dragged directory: no dwell.
		moveOver(button("Inner"))
		moveOver(button("Photos"))

		act(() => {
			vi.advanceTimersByTime(699)
		})
		expect(onToggle).not.toHaveBeenCalled()

		act(() => {
			vi.advanceTimersByTime(1)
		})
		expect(onToggle).toHaveBeenCalledExactlyOnceWith(testUuid("photos"), null)
	})

	it("starts no drag from a touch", () => {
		renderTree()
		pressOn(button("Inner"), "touch")
		moveOver(null)

		expect(getDragPayload()).toEqual([])
	})

	it("carries the node's root-to-node chain for the tree's menu and shortcuts", () => {
		renderTree()

		expect(row("Inner").getAttribute("data-tree-path")).toBe(`${testUuid("docs")}/${testUuid("inner")}`)
		expect(row("Photos").getAttribute("data-tree-path")).toBe(testUuid("photos"))
	})
})
