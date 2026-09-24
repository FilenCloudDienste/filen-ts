// @vitest-environment happy-dom
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"
import { act, cleanup, render } from "@testing-library/react"

vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

import useDriveClipboardStore, { useIsDriveItemCut } from "@/features/drive/store/useDriveClipboard.store"
import type { DriveItem } from "@/types"

function item(uuid: string): DriveItem {
	return { type: "file", data: { uuid } } as unknown as DriveItem
}

const renders = new Map<string, number>()

function Row({ uuid }: { uuid: string }) {
	const isCut = useIsDriveItemCut(uuid)

	renders.set(uuid, (renders.get(uuid) ?? 0) + 1)

	return <span data-testid={uuid}>{isCut ? "cut" : "normal"}</span>
}

beforeEach(() => {
	renders.clear()
	useDriveClipboardStore.getState().clear()
})

afterEach(() => {
	cleanup()
})

describe("useDriveClipboardStore", () => {
	it("tracks cut uuids for a cut and none for a copy", () => {
		useDriveClipboardStore.getState().set({ mode: "cut", items: [item("a"), item("b")] })

		expect(useDriveClipboardStore.getState().cutUuids).toEqual(new Set(["a", "b"]))

		useDriveClipboardStore.getState().set({ mode: "copy", items: [item("a")] })

		expect(useDriveClipboardStore.getState().cutUuids.size).toBe(0)
	})

	it("restores failed cut items only into an empty clipboard", () => {
		useDriveClipboardStore.getState().restoreCut([item("a")])

		expect(useDriveClipboardStore.getState().entry).toEqual({ mode: "cut", items: [item("a")] })

		useDriveClipboardStore.getState().set({ mode: "copy", items: [item("z")] })
		useDriveClipboardStore.getState().restoreCut([item("b")])

		expect(useDriveClipboardStore.getState().entry).toEqual({ mode: "copy", items: [item("z")] })

		useDriveClipboardStore.getState().clear()
		useDriveClipboardStore.getState().restoreCut([])

		expect(useDriveClipboardStore.getState().entry).toBeNull()
	})

	it("re-renders only the rows whose cut state flips", () => {
		const view = render(
			<>
				<Row uuid="a" />
				<Row uuid="b" />
				<Row uuid="c" />
			</>
		)

		act(() => {
			useDriveClipboardStore.getState().set({ mode: "cut", items: [item("a")] })
		})

		expect(view.getByTestId("a").textContent).toBe("cut")
		expect([renders.get("a"), renders.get("b"), renders.get("c")]).toEqual([2, 1, 1])

		act(() => {
			useDriveClipboardStore.getState().set({ mode: "copy", items: [item("a"), item("b")] })
		})

		expect(view.getByTestId("a").textContent).toBe("normal")
		expect([renders.get("a"), renders.get("b"), renders.get("c")]).toEqual([3, 1, 1])
	})
})
