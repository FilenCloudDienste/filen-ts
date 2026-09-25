// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { QueryClient } from "@tanstack/react-query"
import type { File, UuidStr } from "@filen/sdk-rs"

const { performMove } = vi.hoisted(() => ({ performMove: vi.fn() }))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("@/features/drive/lib/actions", () => ({ currentRootUuid: () => "root-0000-0000-0000-000000000000" }))
vi.mock("@/features/drive/lib/dnd", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/lib/dnd")>()),
	performMove
}))
vi.mock("@/features/transfers/lib/copyToast", () => ({ startCopyWithCard: vi.fn() }))

import { narrowItem } from "@/features/drive/lib/item"
import { INTERNAL_DRAG_TYPE, clearDragPayload, setDragPayload } from "@/features/drive/lib/dnd"
import { useDriveDropTarget } from "@/features/drive/hooks/useDriveDropTarget"

const DEST = "dest-0000-0000-0000-000000000000"
const HOME = "home-0000-0000-0000-000000000000"

// Dragged out of HOME, which is listed as a row inside DEST: a move onto the HOME row is a no-op, so the
// row is not a valid drop — the listing's own space (DEST) is.
const REPORT = narrowItem({
	uuid: "report-0000-0000-0000-000000000000" as UuidStr,
	stableUUID: undefined,
	parent: HOME as UuidStr,
	size: 1n,
	favorited: false,
	region: "de-1",
	bucket: "filen-1",
	timestamp: 0n,
	chunks: 1n,
	canMakeThumbnail: false,
	meta: { type: "decoded", data: { name: "report.txt", mime: "text/plain", modified: 0n, size: 1n, key: "k", version: 2 } }
} satisfies File)

function Target({ uuid, ancestry, name, children }: { uuid: string; ancestry: string[]; name: string; children?: ReactNode }) {
	const drop = useDriveDropTarget({ targetUuid: uuid, targetAncestry: ancestry, targetName: name })

	return createElement(
		"div",
		{
			"data-testid": name,
			"data-over": drop.isOver ? "" : undefined,
			onDragEnter: drop.onDragEnter,
			onDragOver: drop.onDragOver,
			onDragLeave: drop.onDragLeave,
			onDrop: drop.onDrop
		},
		children
	)
}

function renderListing() {
	render(
		createElement(
			Target,
			{ uuid: DEST, ancestry: [DEST], name: "background" },
			createElement(Target, { uuid: HOME, ancestry: [DEST, HOME], name: "row" })
		)
	)

	return { background: screen.getByTestId("background"), row: screen.getByTestId("row") }
}

function fire(type: "dragEnter" | "dragLeave" | "dragOver" | "drop", element: Element): Event {
	const event = createEvent[type](element, { dataTransfer: { types: [INTERNAL_DRAG_TYPE], dropEffect: "none" } })

	Object.defineProperty(event, "ctrlKey", { value: false })
	Object.defineProperty(event, "altKey", { value: false })
	fireEvent(element, event)

	return event
}

function isOver(element: Element): boolean {
	return element.hasAttribute("data-over")
}

// The pointer entering the row from the background, then leaving back into it — the browser fires the
// new element's enter before the old one's leave.
function crossRow(background: Element, row: Element): void {
	fire("dragEnter", row)
	fire("dragLeave", background)
	fire("dragEnter", background)
	fire("dragLeave", row)
}

beforeEach(() => {
	setDragPayload([REPORT])
})

afterEach(() => {
	clearDragPayload()
	cleanup()
})

describe("an invalid row inside the listing's own drop target", () => {
	it("leaves the enclosing target's enters and leaves balanced however often it is crossed", () => {
		const { background, row } = renderListing()

		fire("dragEnter", background)

		for (let crossing = 0; crossing < 5; crossing++) {
			crossRow(background, row)
			expect(isOver(background)).toBe(true)
			expect(isOver(row)).toBe(false)
		}

		fire("dragLeave", background)
		expect(isOver(background)).toBe(false)
	})

	it("lets a drop on it through to the enclosing target, which then clears", () => {
		const { background, row } = renderListing()

		fire("dragEnter", background)
		crossRow(background, row)
		fire("dragEnter", row)
		fire("dragLeave", background)

		expect(fire("dragOver", row).defaultPrevented).toBe(true)
		fire("drop", row)

		expect(performMove).toHaveBeenCalledExactlyOnceWith([REPORT], DEST)
		expect(isOver(background)).toBe(false)
	})

	it("clears the enclosing target when the drag ends somewhere that never sends it a leave", () => {
		const { background, row } = renderListing()

		fire("dragEnter", background)
		crossRow(background, row)
		expect(isOver(background)).toBe(true)

		act(() => {
			window.dispatchEvent(new Event("dragend"))
		})
		expect(isOver(background)).toBe(false)
	})
})
