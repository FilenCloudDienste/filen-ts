// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook } from "@testing-library/react"
import type { DragEvent } from "react"
import type { File, UuidStr } from "@filen/sdk-rs"

const { performMove, startCopyWithCard } = vi.hoisted(() => ({ performMove: vi.fn(), startCopyWithCard: vi.fn() }))

vi.mock("@/features/drive/lib/dnd", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/lib/dnd")>()),
	performMove
}))
vi.mock("@/features/transfers/lib/copyToast", () => ({ startCopyWithCard }))
vi.mock("@/features/drive/lib/actions", () => ({ currentRootUuid: () => "root-0000-0000-0000-000000000000" }))

import { narrowItem } from "@/features/drive/lib/item"
import { INTERNAL_DRAG_TYPE, clearDragPayload, setDragPayload } from "@/features/drive/lib/dnd"
import { dropHighlightClass, useDriveDropTarget } from "@/features/drive/hooks/useDriveDropTarget"

const HOME = "home-0000-0000-0000-000000000000"

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

// jsdom's own DragEvent has no DataTransfer; the hook reads only these fields. The copy modifier off
// macOS (jsdom's platform) is Ctrl.
function dragEvent(ctrlKey: boolean) {
	const preventDefault = vi.fn()
	const dataTransfer = { types: [INTERNAL_DRAG_TYPE], dropEffect: "none" }
	const event = { altKey: false, ctrlKey, dataTransfer, preventDefault, stopPropagation: vi.fn() } as unknown as DragEvent<HTMLElement>

	return { event, preventDefault, dataTransfer }
}

function renderTarget(targetUuid: string) {
	return renderHook(() => useDriveDropTarget({ targetUuid, targetAncestry: [targetUuid], targetName: "Docs" }))
}

beforeEach(() => {
	setDragPayload([REPORT])
})

afterEach(() => {
	clearDragPayload()
	cleanup()
})

describe("useDriveDropTarget", () => {
	it("moves on a plain drop", () => {
		const { result } = renderTarget("docs-0000-0000-0000-000000000000")
		const over = dragEvent(false)

		act(() => {
			result.current.onDragOver(over.event)
		})

		expect(over.dataTransfer.dropEffect).toBe("move")
		expect(result.current.mode).toBe("move")

		act(() => {
			result.current.onDrop(dragEvent(false).event)
		})

		expect(performMove).toHaveBeenCalledExactlyOnceWith([REPORT], "docs-0000-0000-0000-000000000000")
		expect(startCopyWithCard).not.toHaveBeenCalled()
	})

	it("copies with the modifier held, showing the copy cursor and outline, and starts the copy's card", () => {
		const { result } = renderTarget("docs-0000-0000-0000-000000000000")
		const over = dragEvent(true)

		act(() => {
			result.current.onDragOver(over.event)
		})

		expect(over.dataTransfer.dropEffect).toBe("copy")
		expect(result.current.mode).toBe("copy")
		expect(dropHighlightClass(result.current)).toContain("outline-dashed")

		act(() => {
			result.current.onDrop(dragEvent(true).event)
		})

		expect(startCopyWithCard).toHaveBeenCalledExactlyOnceWith([REPORT], { uuid: "docs-0000-0000-0000-000000000000", name: "Docs" })
		expect(performMove).not.toHaveBeenCalled()
	})

	it("takes a copy onto the payload's own parent, where a move is refused", () => {
		const { result } = renderTarget(HOME)
		const moveOver = dragEvent(false)

		act(() => {
			result.current.onDragOver(moveOver.event)
		})

		expect(moveOver.preventDefault).not.toHaveBeenCalled()
		expect(result.current.isOver).toBe(false)

		const copyOver = dragEvent(true)

		act(() => {
			result.current.onDragOver(copyOver.event)
		})

		expect(copyOver.preventDefault).toHaveBeenCalled()
		expect(result.current.isOver).toBe(true)

		// Letting go of the modifier over the same target withdraws it again.
		act(() => {
			result.current.onDragOver(dragEvent(false).event)
		})

		expect(result.current.isOver).toBe(false)
	})
})
