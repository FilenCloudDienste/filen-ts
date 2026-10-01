// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import { QueryClient } from "@tanstack/react-query"
import type { File } from "@filen/sdk-rs"
import "@/lib/i18n"

// The tile's menus pull the SDK surface in transitively; none of these cases opens one.
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("@/lib/keymap/kbd", () => ({ Kbd: () => null }))
vi.mock("@/features/drive/hooks/useThumbnail", () => ({ useThumbnail: () => null }))

import { narrowItem } from "@/features/drive/lib/item"
import { type PhotoItem } from "@/features/photos/lib/captureSort"
import { PhotoTile, type PhotoTileProps } from "@/features/photos/components/photoTile"
import { touchLongPress, touchTap } from "@/tests/support/touch"

const INDEX = 7

function photo(): PhotoItem {
	const file: File = {
		uuid: "a-0000-0000-0000-000000000000",
		stableUUID: undefined,
		parent: "root-0000-0000-0000-000000000000",
		size: 1n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: { type: "decoded", data: { name: "a.jpg", mime: "image/jpeg", modified: 0n, size: 1n, key: "k", version: 2 } }
	}
	const item = narrowItem(file)

	if (item.type !== "file") {
		throw new Error("fixture narrowed to a non-file arm")
	}

	return item
}

function renderTile(onTileClick = vi.fn<PhotoTileProps["onTileClick"]>(), onTileToggle = vi.fn<PhotoTileProps["onTileToggle"]>()) {
	render(
		createElement(PhotoTile, {
			rootUuid: "root",
			item: photo(),
			index: INDEX,
			total: 9,
			selected: false,
			active: false,
			registerRef: () => undefined,
			onTileClick,
			onTileToggle,
			onItemAction: () => undefined
		})
	)

	return { tile: screen.getByRole("option"), onTileClick, onTileToggle }
}

beforeEach(() => {
	vi.useFakeTimers()
})

afterEach(() => {
	cleanup()
	vi.useRealTimers()
})

describe("PhotoTile — touch", () => {
	it("reports a tap as touch and a mouse click as mouse", () => {
		const { tile, onTileClick } = renderTile()

		touchTap(tile)
		fireEvent.pointerDown(tile, { pointerType: "mouse", pointerId: 2, isPrimary: true, button: 0 })
		fireEvent.click(tile, { detail: 1 })

		expect(onTileClick.mock.calls.map(call => [call[0], call[2]])).toEqual([
			[INDEX, "touch"],
			[INDEX, "mouse"]
		])
	})

	it("toggles on a long-press, with no menu and no click (so no viewer) after it", () => {
		const { tile, onTileClick, onTileToggle } = renderTile()

		touchLongPress(tile)

		expect(onTileToggle).toHaveBeenCalledExactlyOnceWith(INDEX)
		expect(onTileClick).not.toHaveBeenCalled()
		expect(screen.queryByRole("menu")).toBeNull()
	})
})
