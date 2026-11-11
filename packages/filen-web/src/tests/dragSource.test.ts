// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PointerEvent } from "react"
import { QueryClient } from "@tanstack/react-query"
import type { File, UuidStr } from "@filen/sdk-rs"

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import { narrowItem } from "@/features/drive/lib/item"
import { buildDragSourceProps, buildTreeDragSourceProps, clearDragPayload, getDragPayload } from "@/features/drive/lib/dnd"
import { registerDropTarget } from "@/features/drive/lib/pointerDrag"
import { useDriveStore } from "@/features/drive/store/useDriveStore"
import { endDrag, FAKE_FRAMES, moveOver, releaseOver, stubHitTest } from "@/tests/support/pointerDrag"

function report(name: string) {
	return narrowItem({
		uuid: "report-0000-0000-0000-000000000000" as UuidStr,
		stableUUID: "lineage-0000-0000-0000-000000000000" as UuidStr,
		parent: "home-0000-0000-0000-000000000000" as UuidStr,
		size: 1n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name, mime: "text/plain", modified: 0n, size: 1n, key: "k", version: 2 } }
	} satisfies File)
}

// The fields of the press the source reads.
function press(pointerType = "mouse"): PointerEvent<HTMLElement> {
	return {
		pointerId: 1,
		pointerType,
		button: 0,
		isPrimary: true,
		clientX: 10,
		clientY: 10,
		altKey: false,
		ctrlKey: false
	} as PointerEvent<HTMLElement>
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: [...FAKE_FRAMES] })
	// jsdom has no 2D canvas; the chip is drawn only where there is one.
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null)
	stubHitTest()
})

afterEach(() => {
	endDrag()
	clearDragPayload()
	useDriveStore.setState({ selectedItems: [] })
	document.body.replaceChildren()
	vi.useRealTimers()
})

// A move re-encrypts the passed item's name for the destination's shares and links.
describe("dragging the selection", () => {
	it("carries a selected item as its listing now holds it, not as it was selected", () => {
		const renamed = report("new.txt")

		useDriveStore.setState({ selectedItems: [report("old.txt")] })
		buildDragSourceProps(renamed, "drive", [renamed])?.onPointerDown(press())
		expect(getDragPayload()).toEqual([])

		moveOver(null)
		expect(getDragPayload()).toEqual([renamed])
	})

	it("starts no drag from a touch, which long-presses to select instead", () => {
		const item = report("touched.txt")

		buildDragSourceProps(item, "drive", [item])?.onPointerDown(press("touch"))
		moveOver(null)

		expect(getDragPayload()).toEqual([])
		expect(useDriveStore.getState().selectedItems).toEqual([])
	})

	it("offers no drag outside My Drive", () => {
		expect(buildDragSourceProps(report("a.txt"), "recents", [])).toBeUndefined()
	})
})

describe("letting go of the payload", () => {
	it("lets go once the drag ends, after the drop has read it", () => {
		const dragged = report("dragged.txt")
		const target = document.createElement("div")
		const drop = vi.fn(() => getDragPayload())

		document.body.appendChild(target)
		registerDropTarget(target, { accepts: () => true, springs: () => false, update: () => undefined, drop })
		buildTreeDragSourceProps(() => dragged).onPointerDown(press())
		moveOver(target)
		releaseOver(target)

		expect(drop).toHaveReturnedWith([dragged])
		expect(getDragPayload()).toEqual([])
	})

	// A virtualized row scrolled away, or a spring-loaded open, unmounts the row a drag started from.
	it("a drag survives its source row unmounting", () => {
		const dragged = report("dragged.txt")
		const source = document.createElement("div")
		const target = document.createElement("div")
		const drop = vi.fn()

		document.body.append(source, target)
		registerDropTarget(target, { accepts: () => true, springs: () => false, update: () => undefined, drop })
		buildTreeDragSourceProps(() => dragged).onPointerDown(press())
		moveOver(source)
		source.remove()
		moveOver(target)
		releaseOver(target)

		expect(drop).toHaveBeenCalledExactlyOnceWith("move")
	})

	it("starts no drag from a tree node whose directory isn't cached", () => {
		buildTreeDragSourceProps(() => undefined).onPointerDown(press())
		moveOver(null)

		expect(document.body.classList.contains("pointer-drag")).toBe(false)
	})
})
