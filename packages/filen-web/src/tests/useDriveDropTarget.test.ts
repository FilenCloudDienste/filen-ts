// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook } from "@testing-library/react"
import type { DragEvent } from "react"
import type { Dir, File, UuidStr } from "@filen/sdk-rs"

const { performMove, startCopyWithCard, uploadDroppedFiles } = vi.hoisted(() => ({
	performMove: vi.fn(),
	startCopyWithCard: vi.fn(),
	uploadDroppedFiles: vi.fn()
}))

vi.mock("@/features/drive/lib/dnd", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/lib/dnd")>()),
	performMove
}))
vi.mock("@/features/transfers/lib/copyToast", () => ({ startCopyWithCard }))
vi.mock("@/features/drive/lib/uploadDrop", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/lib/uploadDrop")>()),
	uploadDroppedFiles
}))
vi.mock("@/features/drive/lib/actions", () => ({ currentRootUuid: () => "root-0000-0000-0000-000000000000" }))
vi.mock("@/queries/client", async () => {
	const { QueryClient } = await import("@tanstack/react-query")

	return { queryClient: new QueryClient() }
})

import { queryClient } from "@/queries/client"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { driveListingQueryKey } from "@/features/drive/queries/drive"
import { clearDragPayload, setDragPayload } from "@/features/drive/lib/dnd"
import { dropHighlightClass, useDriveDropTarget } from "@/features/drive/hooks/useDriveDropTarget"
import { LISTING_SPRING, SPRING_LOAD_DELAY_MS } from "@/features/drive/lib/springLoad"
import { beginDrag, endDrag, FAKE_FRAMES, FAKE_FRAMES_AND_TIMEOUTS, moveOver, releaseOver, stubHitTest } from "@/tests/support/pointerDrag"

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

// The element a target registered with the drag engine: what the test points the drag at.
function mountTarget(attach: (element: Element | null) => void): HTMLElement {
	const element = document.createElement("div")

	document.body.appendChild(element)
	act(() => {
		attach(element)
	})

	return element
}

function renderTarget(targetUuid: string) {
	const rendered = renderHook(() => useDriveDropTarget({ targetUuid, targetAncestry: [targetUuid], targetName: "Docs" }))

	return { ...rendered, element: mountTarget(rendered.result.current.attach) }
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
	document.body.replaceChildren()
	vi.useRealTimers()
})

describe("useDriveDropTarget", () => {
	it("moves on a plain drop", () => {
		const { result, element } = renderTarget("docs-0000-0000-0000-000000000000")

		beginDrag()
		moveOver(element)

		expect(result.current.isOver).toBe(true)
		expect(result.current.mode).toBe("move")

		releaseOver(element)

		expect(performMove).toHaveBeenCalledExactlyOnceWith([REPORT], { uuid: "docs-0000-0000-0000-000000000000", name: "Docs" })
		expect(startCopyWithCard).not.toHaveBeenCalled()
		expect(result.current.isOver).toBe(false)
	})

	it("copies with the modifier held, showing the copy outline, and starts the copy's card", () => {
		const { result, element } = renderTarget("docs-0000-0000-0000-000000000000")

		beginDrag()
		moveOver(element, true)

		expect(result.current.mode).toBe("copy")
		expect(dropHighlightClass(result.current)).toContain("outline-dashed")

		releaseOver(element, true)

		expect(startCopyWithCard).toHaveBeenCalledExactlyOnceWith([REPORT], { uuid: "docs-0000-0000-0000-000000000000", name: "Docs" })
		expect(performMove).not.toHaveBeenCalled()
	})

	it("takes a copy onto the payload's own parent, where a move is refused", () => {
		const { result, element } = renderTarget(HOME)

		beginDrag()
		moveOver(element)
		expect(result.current.isOver).toBe(false)

		moveOver(element, true)
		expect(result.current.isOver).toBe(true)

		// Letting go of the modifier over the same target withdraws it again.
		moveOver(element)
		expect(result.current.isOver).toBe(false)

		releaseOver(element)
		expect(performMove).not.toHaveBeenCalled()
	})

	it("is inert to drive items while disabled", () => {
		const { result } = renderHook(() =>
			useDriveDropTarget({ targetUuid: "docs-0000-0000-0000-000000000000", targetAncestry: [], targetName: "Docs", disabled: true })
		)
		const element = mountTarget(result.current.attach)

		beginDrag()
		moveOver(element)
		releaseOver(element)

		expect(result.current.isOver).toBe(false)
		expect(performMove).not.toHaveBeenCalled()
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

	function accepts(copy: boolean): boolean {
		const { result } = renderHook(() =>
			useDriveDropTarget({
				targetUuid: CHILD.data.uuid,
				targetAncestry: [FAV.data.uuid, CHILD.data.uuid],
				routeChain: { parent: CHILD.data.parent },
				targetName: "child"
			})
		)
		const element = mountTarget(result.current.attach)

		beginDrag()
		moveOver(element, copy)

		const over = result.current.isOver

		endDrag()

		return over
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

	// The listing's own background keeps one target while the directory on screen changes under a drag.
	it("walks the new target's chain when the same target moves to another directory mid-drag", () => {
		seed(null, [GRAND, ELSEWHERE])
		seed(GRAND, [FAV])
		seed(FAV, [CHILD])
		setDragPayload([GRAND])

		const { result, rerender } = renderHook(
			({ uuid }: { uuid: string }) =>
				useDriveDropTarget({ targetUuid: uuid, targetAncestry: [uuid], routeChain: { parent: undefined }, targetName: "here" }),
			{ initialProps: { uuid: ELSEWHERE.data.uuid } }
		)
		const element = mountTarget(result.current.attach)

		beginDrag()
		moveOver(element)
		expect(result.current.isOver).toBe(true)

		rerender({ uuid: CHILD.data.uuid })
		moveOver(element)
		expect(result.current.isOver).toBe(false)
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

// A drag resting on a directory it could drop into opens it (springLoad.ts): one page-wide timer, armed
// on the hovered element.
describe("spring-loading", () => {
	const DOCS = "docs-0000-0000-0000-000000000000"

	// An OS file drag's event: the browser exposes only the "Files" type until the drop.
	function fileEvent() {
		const preventDefault = vi.fn()
		const currentTarget = document.createElement("div")
		const dataTransfer = { types: ["Files"], dropEffect: "none" }
		const event = { dataTransfer, currentTarget, preventDefault, stopPropagation: vi.fn() } as unknown as DragEvent<HTMLElement>

		return { event, preventDefault, dataTransfer }
	}

	function renderSpringTarget(options: { ancestry?: string[]; acceptFiles?: boolean } = {}) {
		const open = vi.fn()
		const rendered = renderHook(() =>
			useDriveDropTarget({
				targetUuid: DOCS,
				targetAncestry: options.ancestry ?? [DOCS],
				targetName: "Docs",
				spring: { timing: LISTING_SPRING, open },
				acceptFiles: options.acceptFiles ?? false
			})
		)

		return { ...rendered, open, element: mountTarget(rendered.result.current.attach) }
	}

	beforeEach(() => {
		vi.useFakeTimers({ toFake: [...FAKE_FRAMES_AND_TIMEOUTS] })
	})

	it("opens the directory once the drag has rested on it for the delay", () => {
		const { result, open, element } = renderSpringTarget()

		beginDrag()
		moveOver(element)
		expect(result.current.isOver).toBe(true)

		act(() => {
			vi.advanceTimersByTime(SPRING_LOAD_DELAY_MS - 1)
		})
		expect(open).not.toHaveBeenCalled()

		act(() => {
			vi.advanceTimersByTime(1)
		})
		expect(open).toHaveBeenCalledOnce()
	})

	it("keeps its timer while the drag moves about on it", () => {
		const { open, element } = renderSpringTarget()

		beginDrag()
		moveOver(element)
		act(() => {
			vi.advanceTimersByTime(SPRING_LOAD_DELAY_MS / 2)
		})
		moveOver(element)
		act(() => {
			vi.advanceTimersByTime(SPRING_LOAD_DELAY_MS / 2)
		})

		expect(open).toHaveBeenCalledOnce()
	})

	it("cancels when the drag leaves, drops, or the target unmounts", () => {
		const leave = renderSpringTarget()

		beginDrag()
		moveOver(leave.element)
		moveOver(null)
		act(() => {
			vi.advanceTimersByTime(SPRING_LOAD_DELAY_MS)
		})
		expect(leave.open).not.toHaveBeenCalled()
		endDrag()

		const dropped = renderSpringTarget()

		beginDrag()
		moveOver(dropped.element)
		releaseOver(dropped.element)
		act(() => {
			vi.advanceTimersByTime(SPRING_LOAD_DELAY_MS)
		})
		expect(dropped.open).not.toHaveBeenCalled()

		const unmounted = renderSpringTarget()

		beginDrag()
		moveOver(unmounted.element)
		unmounted.unmount()
		act(() => {
			vi.advanceTimersByTime(SPRING_LOAD_DELAY_MS)
		})
		expect(unmounted.open).not.toHaveBeenCalled()
	})

	it("never springs into a dragged directory itself or below it", () => {
		const docsItem = narrowItem({
			uuid: DOCS as UuidStr,
			parent: HOME as UuidStr,
			color: "default",
			timestamp: 0n,
			favorited: false,
			meta: { type: "decoded", data: { name: "Docs" } }
		} satisfies Dir)
		const inner = "inner-0000-0000-0000-000000000000"

		setDragPayload([docsItem])

		const self = renderSpringTarget()
		const below = renderHook(() =>
			useDriveDropTarget({
				targetUuid: inner,
				targetAncestry: [DOCS, inner],
				targetName: "Inner",
				spring: { timing: LISTING_SPRING, open: self.open }
			})
		)
		const belowElement = mountTarget(below.result.current.attach)

		beginDrag()
		moveOver(self.element)
		moveOver(self.element, true)
		moveOver(belowElement)
		act(() => {
			vi.advanceTimersByTime(SPRING_LOAD_DELAY_MS)
		})

		expect(self.open).not.toHaveBeenCalled()
	})

	// A move onto the payload's own parent is refused (a no-op), but the drag may still spring through it,
	// as in Finder: only the dragged directory and what lies below it never spring.
	it("springs through the payload's own parent without claiming the drop there", () => {
		setDragPayload([REPORT])
		const open = vi.fn()
		const { result } = renderHook(() =>
			useDriveDropTarget({
				targetUuid: HOME,
				targetAncestry: [HOME],
				targetName: "Home",
				spring: { timing: LISTING_SPRING, open }
			})
		)
		const element = mountTarget(result.current.attach)

		beginDrag()
		moveOver(element)
		act(() => {
			vi.advanceTimersByTime(SPRING_LOAD_DELAY_MS)
		})

		expect(result.current.isOver).toBe(false)
		expect(open).toHaveBeenCalledOnce()
	})

	it("springs and uploads for files from the system where the target takes them, and leaves them alone elsewhere", () => {
		const taking = renderSpringTarget({ acceptFiles: true })
		const enter = fileEvent()

		act(() => {
			taking.result.current.handlers.onDragEnter(enter.event)
		})
		expect(enter.preventDefault).toHaveBeenCalled()
		expect(taking.result.current.mode).toBe("copy")

		act(() => {
			vi.advanceTimersByTime(SPRING_LOAD_DELAY_MS)
		})
		expect(taking.open).toHaveBeenCalledOnce()

		const drop = fileEvent()

		act(() => {
			taking.result.current.handlers.onDrop(drop.event)
		})
		expect(uploadDroppedFiles).toHaveBeenCalledExactlyOnceWith(drop.dataTransfer, DOCS)

		const refusing = renderSpringTarget()
		const ignored = fileEvent()

		act(() => {
			refusing.result.current.handlers.onDragEnter(ignored.event)
			vi.advanceTimersByTime(SPRING_LOAD_DELAY_MS)
		})
		expect(ignored.preventDefault).not.toHaveBeenCalled()
		expect(refusing.open).not.toHaveBeenCalled()
	})
})
