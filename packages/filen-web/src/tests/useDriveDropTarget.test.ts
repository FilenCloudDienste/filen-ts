// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook } from "@testing-library/react"
import type { DragEvent } from "react"
import type { Dir, File, UuidStr } from "@filen/sdk-rs"

const { performMove, startCopyWithCard } = vi.hoisted(() => ({ performMove: vi.fn(), startCopyWithCard: vi.fn() }))

vi.mock("@/features/drive/lib/dnd", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/lib/dnd")>()),
	performMove
}))
vi.mock("@/features/transfers/lib/copyToast", () => ({ startCopyWithCard }))
vi.mock("@/features/drive/lib/actions", () => ({ currentRootUuid: () => "root-0000-0000-0000-000000000000" }))
vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/queries/client", async () => {
	const { QueryClient } = await import("@tanstack/react-query")

	return { queryClient: new QueryClient() }
})

import { queryClient } from "@/queries/client"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { driveListingQueryKey } from "@/features/drive/queries/drive"
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

// A route can start below the root: a directory opened from Favorites lists at /drive/<it>, so the
// route names none of its ancestors. The sidebar tree can drag any of them onto a row there.
describe("a row on a route cut short", () => {
	function dir(label: string, parent: string): DriveItem {
		return narrowItem({
			uuid: `${label}-0000-0000-0000-000000000000` as UuidStr,
			parent: `${parent}-0000-0000-0000-000000000000` as UuidStr,
			color: "default",
			timestamp: 0n,
			favorited: false,
			meta: { type: "decoded", data: { name: label } }
		} satisfies Dir)
	}

	// root > grand > fav > child; the route is /drive/fav.
	const GRAND = dir("grand", "root")
	const FAV = dir("fav", "grand")
	const CHILD = dir("child", "fav")
	const ELSEWHERE = dir("elsewhere", "root")

	function seed(parent: DriveItem | null, items: DriveItem[]): void {
		queryClient.setQueryData(driveListingQueryKey({ variant: "drive", uuid: parent?.data.uuid ?? null }), items)
	}

	function renderChildRow() {
		return renderHook(() =>
			useDriveDropTarget({
				targetUuid: CHILD.data.uuid,
				targetAncestry: [FAV.data.uuid, CHILD.data.uuid],
				routeChain: { parent: CHILD.data.parent },
				targetName: "child"
			})
		)
	}

	function accepts(copy: boolean): boolean {
		const { result } = renderChildRow()
		const over = dragEvent(copy)

		act(() => {
			result.current.onDragOver(over.event)
		})

		return over.preventDefault.mock.calls.length > 0
	}

	beforeEach(() => {
		queryClient.clear()
	})

	it("refuses moving or copying an ancestor the route doesn't name into its own subtree", () => {
		seed(null, [GRAND, ELSEWHERE])
		seed(GRAND, [FAV])
		seed(FAV, [CHILD])
		setDragPayload([GRAND])

		expect(accepts(false)).toBe(false)
		expect(accepts(true)).toBe(false)
	})

	it("refuses a directory where the chain above the route can't be resolved", () => {
		seed(FAV, [CHILD])
		setDragPayload([ELSEWHERE])

		expect(accepts(false)).toBe(false)
	})

	it("takes an unrelated directory once the chain resolves, and a file without walking it", () => {
		seed(null, [GRAND, ELSEWHERE])
		seed(GRAND, [FAV])
		seed(FAV, [CHILD])
		setDragPayload([ELSEWHERE])

		expect(accepts(false)).toBe(true)

		queryClient.clear()
		setDragPayload([REPORT])

		expect(accepts(false)).toBe(true)
	})
})
