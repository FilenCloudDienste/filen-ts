// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"
import { createElement } from "react"
import type { Dir, UuidStr } from "@filen/sdk-rs"
import "@/lib/i18n"

// The row/tile pull the SDK surface in transitively (item menu -> actions); a Vite `?worker` import is
// unresolvable under vitest and no case here reaches a worker op. The thumbnail + drop hooks are
// stubbed for the same reason: neither is what these assertions are about.
vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/features/drive/hooks/useThumbnail", () => ({ useThumbnail: () => null }))
vi.mock("@/features/drive/hooks/useDriveDropTarget", () => ({
	useDriveDropTarget: () => ({
		isOver: false,
		onDragEnter: () => undefined,
		onDragOver: () => undefined,
		onDragLeave: () => undefined,
		onDrop: () => undefined
	})
}))

import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { useDriveStore } from "@/features/drive/store/useDriveStore"
import { DriveRow } from "@/features/drive/components/driveRow"
import { DriveTile } from "@/features/drive/components/driveTile"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function dirItem(label: string): DriveItem {
	const dir: Dir = {
		uuid: testUuid(label),
		parent: testUuid("parent"),
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "decoded", data: { name: label } }
	}

	return narrowItem(dir)
}

const ROW_INDEX = 4

function sharedProps(item: DriveItem, selected: boolean, onCursorMove: (index: number) => void) {
	return {
		item,
		index: ROW_INDEX,
		total: 9,
		selected,
		active: false,
		variant: "drive" as const,
		splat: "",
		selectedItems: selected ? [item, dirItem("other")] : [],
		onPointerSelect: () => undefined,
		onCursorMove,
		onOpen: () => undefined,
		onItemAction: () => undefined,
		onBulkAction: () => undefined,
		registerRef: () => undefined
	}
}

function renderRow(item: DriveItem, selected: boolean, onCursorMove: (index: number) => void) {
	return render(createElement(DriveRow, { ...sharedProps(item, selected, onCursorMove), style: {}, directorySizes: new Map() }))
}

function renderTile(item: DriveItem, selected: boolean, onCursorMove: (index: number) => void) {
	return render(createElement(DriveTile, sharedProps(item, selected, onCursorMove)))
}

function rightClick(container: HTMLElement): void {
	const row = container.querySelector('[role="option"]')

	if (!row) {
		throw new Error("no option row rendered")
	}

	fireEvent.contextMenu(row)
}

beforeEach(() => {
	useDriveStore.setState({ selectedItems: [] })
})

afterEach(() => {
	cleanup()
})

describe("right-click retarget", () => {
	it("a row retargets the selection AND the roving cursor/anchor", () => {
		const item = dirItem("target")
		const onCursorMove = vi.fn()
		const { container } = renderRow(item, false, onCursorMove)

		rightClick(container)

		expect(useDriveStore.getState().selectedItems).toEqual([item])
		expect(onCursorMove).toHaveBeenCalledExactlyOnceWith(ROW_INDEX)
	})

	it("a tile retargets both the same way", () => {
		const item = dirItem("target")
		const onCursorMove = vi.fn()
		const { container } = renderTile(item, false, onCursorMove)

		rightClick(container)

		expect(useDriveStore.getState().selectedItems).toEqual([item])
		expect(onCursorMove).toHaveBeenCalledExactlyOnceWith(ROW_INDEX)
	})

	it("leaves an already-selected row's selection and cursor alone (the bulk menu opens over the whole selection)", () => {
		const item = dirItem("target")
		const onCursorMove = vi.fn()
		const { container } = renderRow(item, true, onCursorMove)

		rightClick(container)

		expect(useDriveStore.getState().selectedItems).toEqual([])
		expect(onCursorMove).not.toHaveBeenCalled()
	})
})
