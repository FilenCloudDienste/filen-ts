// @vitest-environment jsdom

import "@/tests/support/officeKeys"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useEffect } from "react"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { inThreadSheetHost } from "@filen/office/dom/sheet"
import type { SheetGridModel, SheetGridProps, SheetGridSizes } from "@filen/office/react/sheet"
import type { DriveItem } from "@/features/drive/lib/item"
import { preview } from "@/locales/en/preview"

// Sizes the spreadsheet viewer keeps beside a file whose session cannot hold them (a CSV): the grid's model
// routes a resize to the app's layer, which the key-value store keeps across a reopen, and a row or column
// structure edit moves them (an undone delete gets them back). The grid's menu resets them there too, and an entry
// open as the file stops being editable is committed, not dropped.

const { kv, seen } = vi.hoisted(() => {
	const held: { grid: SheetGridModel | null; sizes: SheetGridSizes | null } = { grid: null, sizes: null }

	return { kv: new Map<string, unknown>(), seen: held }
})

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(kv.get(key) ?? null),
	kvSetJson: (key: string, value: unknown) => {
		kv.set(key, structuredClone(value))

		return Promise.resolve()
	},
	kvDelete: (key: string) => {
		kv.delete(key)

		return Promise.resolve()
	}
}))

vi.mock("@/providers/themeProvider", async importOriginal => ({
	...(await importOriginal<typeof import("@/providers/themeProvider")>()),
	useTheme: () => ({ theme: "light" })
}))

vi.mock("@/features/preview/hooks/usePreviewBytes", () => ({
	usePreviewBytes: () => ({ status: "success", bytes: CSV, refetch: () => undefined })
}))

vi.mock("@/features/spreadsheet/lib/sheetHosts", async importOriginal => {
	const host = inThreadSheetHost()

	return {
		...(await importOriginal<typeof import("@/features/spreadsheet/lib/sheetHosts")>()),
		openSheet: (source: Uint8Array, options: Parameters<typeof host.open>[1], onEvent: Parameters<typeof host.open>[2]) =>
			host.open(source, options, onEvent)
	}
})

// The grid itself draws on a canvas jsdom does not have: a stand-in that keeps what the shell hands it and passes the
// size layer on to the model, as the grid does.
vi.mock("@filen/office/react/sheet", async importOriginal => ({
	...(await importOriginal<typeof import("@filen/office/react/sheet")>()),
	SheetGrid: function StandIn(props: SheetGridProps) {
		const { grid, sizes } = props

		seen.grid = grid
		seen.sizes = sizes ?? null

		// As the grid does: the model takes the layer it is handed.
		useEffect(() => {
			grid.setSizes(sizes ?? null)
		}, [grid, sizes])

		return null
	}
}))

const CSV = Uint8Array.from(new TextEncoder().encode("a,b,c\r\n1,2,3\r\n"))

const { SheetViewer } = await import("@/features/spreadsheet/sheetViewer")

const item = {
	type: "file",
	data: { uuid: "u-sizes", stableUUID: "stable-sizes", decryptedMeta: { name: "s.csv" }, size: 1n }
} as unknown as DriveItem

function open() {
	return render(
		<SheetViewer
			item={item}
			documentKey="sizes"
			alt="s.csv"
			editable
		/>
	)
}

function grid(): SheetGridModel {
	if (seen.grid === null) {
		throw new Error("no grid yet")
	}

	return seen.grid
}

function columns(): ReadonlyMap<number, number> | undefined {
	return seen.sizes?.sizes(grid().getSnapshot().sheet)?.cols
}

describe("sizes kept beside a text file", () => {
	beforeEach(() => {
		kv.clear()
		seen.grid = null
		seen.sizes = null
	})

	it("keeps a resized column across a reopen", async () => {
		const first = open()

		await waitFor(
			() => {
				expect(seen.sizes).not.toBeNull()
			},
			{ timeout: 5000 }
		)
		await act(() => grid().resize(grid().getSnapshot().sheet, "cols", Uint32Array.of(1), Float32Array.of(140)))
		await waitFor(
			() => {
				expect(columns()?.get(1)).toBe(140)
			},
			{ timeout: 5000 }
		)
		await waitFor(
			() => {
				expect([...kv.keys()].some(key => key.includes("stable-sizes"))).toBe(true)
			},
			{ timeout: 5000 }
		)
		first.unmount()
		seen.grid = null

		open()
		await waitFor(
			() => {
				expect(columns()?.get(1)).toBe(140)
			},
			{ timeout: 5000 }
		)
	})

	it("moves the sizes with a deleted column and gives them back when the delete is undone", async () => {
		open()
		await waitFor(
			() => {
				expect(seen.sizes).not.toBeNull()
			},
			{ timeout: 5000 }
		)

		const sheet = grid().getSnapshot().sheet

		await act(() => grid().resize(sheet, "cols", Uint32Array.of(2), Float32Array.of(150)))
		await waitFor(
			() => {
				expect(columns()?.get(2)).toBe(150)
			},
			{ timeout: 5000 }
		)

		await act(async () => {
			const deleted = await grid().command({ type: "axis.delete", sheet, axis: "cols", at: 0, count: 1 })

			expect(deleted.ok).toBe(true)
		})
		await waitFor(
			() => {
				expect(columns()?.get(1)).toBe(150)
			},
			{ timeout: 5000 }
		)
		expect(columns()?.has(2)).toBe(false)

		await act(async () => {
			expect((await grid().undo()).ok).toBe(true)
		})
		await waitFor(
			() => {
				expect(columns()?.get(2)).toBe(150)
			},
			{ timeout: 5000 }
		)
		expect(columns()?.has(1)).toBe(false)
	})

	it("resets a kept column width from the grid's menu", async () => {
		const view = open()

		await waitFor(
			() => {
				expect(seen.sizes).not.toBeNull()
			},
			{ timeout: 5000 }
		)

		const sheet = grid().getSnapshot().sheet

		await act(() => grid().resize(sheet, "cols", Uint32Array.of(1), Float32Array.of(140)))
		await waitFor(
			() => {
				expect(columns()?.get(1)).toBe(140)
			},
			{ timeout: 5000 }
		)
		act(() => {
			grid().select({
				active: { row: 0, col: 1 },
				anchor: { row: 0, col: 1 },
				focus: { row: 0, col: 1 },
				ranges: [{ startRow: 0, startCol: 1, endRow: 0, endCol: 1 }]
			})
		})

		const refusals: string[] = []

		grid().setRefusalHandler(refusal => refusals.push(refusal.reason))

		const trigger = view.container.querySelector("[data-slot=context-menu-trigger]")

		if (trigger === null) {
			throw new Error("no menu trigger")
		}

		fireEvent.contextMenu(trigger)
		fireEvent.click(await screen.findByText(preview.previewSpreadsheetResetColumnWidth_one))
		await waitFor(
			() => {
				expect(columns()?.get(1)).toBeUndefined()
			},
			{ timeout: 5000 }
		)
		expect(refusals).toEqual([])
	})

	it("commits an open entry when the file stops being editable", async () => {
		const dirty: boolean[] = []
		const shown = (editable: boolean) => (
			<SheetViewer
				item={item}
				documentKey="sizes"
				alt="s.csv"
				editable={editable}
				onDirtyChange={value => dirty.push(value)}
			/>
		)
		const view = render(shown(true))

		await waitFor(
			() => {
				expect(seen.grid).not.toBeNull()
			},
			{ timeout: 5000 }
		)
		act(() => {
			expect(grid().startEditing("typed", "enter")).toBe(true)
		})
		await waitFor(
			() => {
				expect(dirty.at(-1)).toBe(true)
			},
			{ timeout: 5000 }
		)

		// A rename to another format, or a failed save locking the buffer: the overlay passes editable={false}.
		view.rerender(shown(false))

		const sheet = grid().getSnapshot().sheet

		await waitFor(async () => {
			expect((await grid().session.query("cell", { sheet, row: 0, col: 0 })).input).toBe("typed")
		})
		expect(grid().getSnapshot().editing).toBeNull()
		expect(dirty.at(-1)).toBe(true)
	})
})
