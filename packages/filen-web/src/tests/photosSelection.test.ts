import { beforeEach, describe, expect, it } from "vitest"
import type { MouseEvent as ReactMouseEvent } from "react"
import type { File, UuidStr } from "@filen/sdk-rs"
import { narrowItem } from "@/features/drive/lib/item"
import { type PhotoItem } from "@/features/photos/lib/captureSort"
import { usePhotosStore } from "@/features/photos/store/usePhotosStore"
import { usePhotosSelection } from "@/features/photos/hooks/usePhotosSelection"

// usePhotosSelection calls no React hooks of its own (anchor state is threaded in by the caller — see
// photoGrid.tsx) — it's exercisable as a plain function, no renderHook/jsdom needed, mirroring how
// listbox.ts's own pure functions are tested directly.

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function mockFile(uuid: UuidStr): File {
	return {
		uuid,
		parent: testUuid("root"),
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: { type: "decoded", data: { name: `${uuid}.jpg`, mime: "image/jpeg", modified: 1n, size: 1n, key: "k", version: 2 } }
	}
}

function photoItem(uuid: UuidStr): PhotoItem {
	const item = narrowItem(mockFile(uuid))

	if (item.type !== "file") {
		throw new Error("test fixture narrowed to a non-file arm")
	}

	return item
}

function clickEvent(
	modifiers: Partial<Pick<ReactMouseEvent<HTMLDivElement>, "shiftKey" | "metaKey" | "ctrlKey">> = {}
): ReactMouseEvent<HTMLDivElement> {
	return { shiftKey: false, metaKey: false, ctrlKey: false, ...modifiers } as ReactMouseEvent<HTMLDivElement>
}

const a = photoItem(testUuid("a"))
const b = photoItem(testUuid("b"))
const c = photoItem(testUuid("c"))
const d = photoItem(testUuid("d"))
const items = [a, b, c, d]

let anchor: string | null = null
function setAnchor(uuid: string | null): void {
	anchor = uuid
}

beforeEach(() => {
	usePhotosStore.setState({ selectedItems: [] })
	anchor = null
})

function uuidsOf(list: PhotoItem[]): string[] {
	return list.map(item => item.data.uuid)
}

describe("usePhotosSelection — plain click", () => {
	it("selects exactly the clicked item, replacing any prior selection", () => {
		usePhotosStore.getState().setSelectedItems([b, c])
		const { handlePointerSelect } = usePhotosSelection(items, anchor, setAnchor)

		handlePointerSelect(0, clickEvent())

		expect(uuidsOf(usePhotosStore.getState().selectedItems)).toEqual([a.data.uuid])
	})

	it("moves the anchor to the clicked item", () => {
		const { handlePointerSelect } = usePhotosSelection(items, anchor, setAnchor)

		handlePointerSelect(2, clickEvent())

		expect(anchor).toBe(c.data.uuid)
	})
})

describe("usePhotosSelection — ctrl/cmd click", () => {
	it("toggles the clicked item into the selection without clearing the rest", () => {
		usePhotosStore.getState().setSelectedItems([a])
		const { handlePointerSelect } = usePhotosSelection(items, anchor, setAnchor)

		handlePointerSelect(1, clickEvent({ ctrlKey: true }))

		expect(uuidsOf(usePhotosStore.getState().selectedItems)).toEqual([a.data.uuid, b.data.uuid])
	})

	it("toggles an already-selected item back OUT", () => {
		usePhotosStore.getState().setSelectedItems([a, b])
		const { handlePointerSelect } = usePhotosSelection(items, anchor, setAnchor)

		handlePointerSelect(0, clickEvent({ metaKey: true }))

		expect(uuidsOf(usePhotosStore.getState().selectedItems)).toEqual([b.data.uuid])
	})
})

describe("usePhotosSelection — shift click", () => {
	it("selects the inclusive range from the anchor to the clicked index", () => {
		anchor = a.data.uuid
		const { handlePointerSelect } = usePhotosSelection(items, anchor, setAnchor)

		handlePointerSelect(2, clickEvent({ shiftKey: true }))

		expect(uuidsOf(usePhotosStore.getState().selectedItems)).toEqual([a.data.uuid, b.data.uuid, c.data.uuid])
	})

	it("handles a range extended BACKWARDS (clicked index before the anchor)", () => {
		anchor = d.data.uuid
		const { handlePointerSelect } = usePhotosSelection(items, anchor, setAnchor)

		handlePointerSelect(1, clickEvent({ shiftKey: true }))

		expect(uuidsOf(usePhotosStore.getState().selectedItems)).toEqual([b.data.uuid, c.data.uuid, d.data.uuid])
	})

	it("falls back to the clicked index alone when there is no prior anchor", () => {
		const { handlePointerSelect } = usePhotosSelection(items, null, setAnchor)

		handlePointerSelect(2, clickEvent({ shiftKey: true }))

		expect(uuidsOf(usePhotosStore.getState().selectedItems)).toEqual([c.data.uuid])
	})
})

describe("usePhotosSelection — out-of-range index", () => {
	it("is a no-op when the clicked index has no matching item", () => {
		usePhotosStore.getState().setSelectedItems([a])
		const { handlePointerSelect } = usePhotosSelection(items, anchor, setAnchor)

		handlePointerSelect(99, clickEvent())

		expect(uuidsOf(usePhotosStore.getState().selectedItems)).toEqual([a.data.uuid])
	})
})
