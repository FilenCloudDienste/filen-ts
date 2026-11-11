// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { QueryClient } from "@tanstack/react-query"
import type { File, UuidStr } from "@filen/sdk-rs"

const { performMove } = vi.hoisted(() => ({ performMove: vi.fn() }))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("@/features/drive/lib/actions", () => ({ currentRootUuid: () => "root-0000-0000-0000-000000000000" }))
vi.mock("@/features/drive/lib/dnd", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/lib/dnd")>()),
	performMove
}))
vi.mock("@/features/transfers/lib/copyToast", () => ({ startCopyWithCard: vi.fn() }))

import { narrowItem } from "@/features/drive/lib/item"
import { clearDragPayload, setDragPayload } from "@/features/drive/lib/dnd"
import { useDriveDropTarget } from "@/features/drive/hooks/useDriveDropTarget"
import { beginDrag, endDrag, FAKE_FRAMES, moveOver, pressEscape, releaseOver, stubHitTest } from "@/tests/support/pointerDrag"

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
			ref: drop.attach,
			...drop.handlers
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

function isOver(element: Element): boolean {
	return element.hasAttribute("data-over")
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: [...FAKE_FRAMES] })
	stubHitTest()
	setDragPayload([REPORT])
})

afterEach(() => {
	endDrag()
	clearDragPayload()
	cleanup()
	vi.useRealTimers()
})

describe("an invalid row inside the listing's own drop target", () => {
	it("leaves the enclosing target lit however often the drag crosses it", () => {
		const { background, row } = renderListing()

		beginDrag()
		moveOver(background)

		for (let crossing = 0; crossing < 5; crossing++) {
			moveOver(row)
			expect(isOver(background)).toBe(true)
			expect(isOver(row)).toBe(false)
			moveOver(background)
			expect(isOver(background)).toBe(true)
		}

		moveOver(null)
		expect(isOver(background)).toBe(false)
	})

	it("lets a drop on it through to the enclosing target, which then clears", () => {
		const { background, row } = renderListing()

		beginDrag()
		moveOver(row)
		releaseOver(row)

		expect(performMove).toHaveBeenCalledExactlyOnceWith([REPORT], { uuid: DEST, name: "background" })
		expect(isOver(background)).toBe(false)
	})

	it("clears the enclosing target when Escape cancels the drag", () => {
		const { background, row } = renderListing()

		beginDrag()
		moveOver(row)
		expect(isOver(background)).toBe(true)

		pressEscape()
		expect(isOver(background)).toBe(false)
		expect(performMove).not.toHaveBeenCalled()
	})
})
