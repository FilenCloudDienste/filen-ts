// @vitest-environment jsdom

// A list whose rows come and go keeps its scrollbar's room reserved, so rows never reflow as it appears or goes.
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render } from "@testing-library/react"
import { createElement } from "react"
import type { UseQueryResult } from "@tanstack/react-query"
import type { DriveItem } from "@/features/drive/lib/item"
import { DialogListRows } from "@/components/dialogListRows"
import { PickerListShell } from "@/features/drive/components/directoryPicker"
import { ListColumnHeader } from "@/features/drive/components/listColumnHeader"
import "@/lib/i18n"

const GUTTER = "scrollbar-gutter-stable"

afterEach(cleanup)

describe("the stable scrollbar gutter", () => {
	it("is reserved by a list dialog's rows", () => {
		const { container } = render(
			createElement(DialogListRows<string>, {
				items: ["a", "b"],
				itemKey: item => item,
				estimateSize: 40,
				renderItem: item => item
			})
		)

		expect(container.firstElementChild?.classList.contains(GUTTER)).toBe(true)
	})

	it("is reserved by the drive pickers' list", () => {
		const listingQuery = { status: "success", data: [] } as unknown as UseQueryResult<DriveItem[]>
		const { container } = render(createElement(PickerListShell, { listingQuery, count: 0, rowKey: String, renderRow: () => null }))

		expect(container.firstElementChild?.classList.contains(GUTTER)).toBe(true)
	})

	it("is reserved by the list view's column header too, so its columns stay over the rows'", () => {
		const { container } = render(createElement(ListColumnHeader, { sort: "nameAsc", onSortChange: () => undefined, disabled: false }))

		expect(container.firstElementChild?.classList.contains(GUTTER)).toBe(true)
	})
})
