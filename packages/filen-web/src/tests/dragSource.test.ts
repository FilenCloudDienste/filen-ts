// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import type { DragEvent } from "react"
import { QueryClient } from "@tanstack/react-query"
import type { File, UuidStr } from "@filen/sdk-rs"

vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import { narrowItem } from "@/features/drive/lib/item"
import { buildDragSourceProps, clearDragPayload, getDragPayload } from "@/features/drive/lib/dnd"
import { useDriveStore } from "@/features/drive/store/useDriveStore"

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

// jsdom's own DragEvent has no DataTransfer; the drag source writes only these.
function dragStart(): DragEvent<HTMLElement> {
	return { dataTransfer: { effectAllowed: "none", setData: vi.fn(), setDragImage: vi.fn() } } as unknown as DragEvent<HTMLElement>
}

afterEach(() => {
	clearDragPayload()
	useDriveStore.setState({ selectedItems: [] })
})

// A move re-encrypts the passed item's name for the destination's shares and links.
describe("dragging the selection", () => {
	it("carries a selected item as its listing now holds it, not as it was selected", () => {
		// jsdom has no 2D canvas; the drag image is drawn only where there is one.
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null)

		const renamed = report("new.txt")

		useDriveStore.setState({ selectedItems: [report("old.txt")] })
		buildDragSourceProps(renamed, "drive", [renamed])?.onDragStart(dragStart())

		expect(getDragPayload()).toEqual([renamed])
	})
})
