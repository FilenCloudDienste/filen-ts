// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import type { DriveItem } from "@/features/drive/lib/item"
import type { SpreadsheetDoc } from "@/features/spreadsheet/lib/model"

const { open, close, undo, redo, apply } = vi.hoisted(() => ({
	open: vi.fn(),
	close: vi.fn(),
	undo: vi.fn(),
	redo: vi.fn(),
	apply: vi.fn()
}))

vi.mock("@/features/spreadsheet/lib/spreadsheetClient", () => ({
	spreadsheetWorker: () => ({ open, close, undo, redo, apply }),
	spreadsheetFileKind: (extension: string) =>
		(({ xlsx: "xlsx", xlsm: "xlsx", xls: "xls", csv: "csv", tsv: "tsv" }) as Record<string, string>)[extension] ?? null,
	sniffSpreadsheetKind: () => "csv"
}))

const BYTES = new Uint8Array([1, 2, 3])

vi.mock("@/features/preview/hooks/usePreviewBytes", () => ({
	usePreviewBytes: () => ({ status: "success", bytes: BYTES, refetch: () => undefined })
}))

const { useSpreadsheetDoc } = await import("@/features/spreadsheet/hooks/useSpreadsheetDoc")
const { useSpreadsheetEdits } = await import("@/features/spreadsheet/hooks/useSpreadsheetEdits")
const { gridDoc } = await import("@/features/spreadsheet/lib/cellStore.logic")

const DOC: SpreadsheetDoc = { kind: "csv", sheets: [], activeSheet: 0, styles: [], writable: true }

function file(uuid: string, name: string): DriveItem {
	return { type: "file", data: { uuid, decryptedMeta: { name } } } as unknown as DriveItem
}

describe("useSpreadsheetDoc", () => {
	it("keeps the document across an own save, and stops saving once renamed to another format", async () => {
		open.mockResolvedValue({ id: 7, doc: DOC })

		const { result, rerender } = renderHook(({ item }) => useSpreadsheetDoc(item, "key"), {
			initialProps: { item: file("u1", "t.csv") }
		})

		await waitFor(() => {
			expect(result.current.status).toBe("ready")
		})
		expect(result.current).toMatchObject({ id: 7, unnamed: false, renamed: false })

		rerender({ item: file("u2", "t.csv") })
		expect(result.current).toMatchObject({ id: 7, renamed: false })

		rerender({ item: file("u2", "t.xlsx") })
		expect(result.current).toMatchObject({ id: 7, renamed: true })
		expect(open).toHaveBeenCalledTimes(1)
	})
})

describe("useSpreadsheetEdits", () => {
	it("sends no undo or redo when there is nothing to undo or redo, so nothing shows as pending", async () => {
		const { result } = renderHook(() => useSpreadsheetEdits(1, gridDoc(DOC)))
		let outcome: unknown

		await act(async () => {
			outcome = await result.current.undo()
			await result.current.redo()
		})

		expect(outcome).toMatchObject({ type: "none" })
		expect(undo).not.toHaveBeenCalled()
		expect(redo).not.toHaveBeenCalled()
		expect(result.current.pending).toBe(false)
	})

	it("counts an edit as pending until the worker answers", async () => {
		let answer: (value: unknown) => void = () => undefined

		apply.mockReturnValue(
			new Promise(resolve => {
				answer = resolve
			})
		)

		const { result } = renderHook(() => useSpreadsheetEdits(1, gridDoc(DOC)))
		let done: Promise<unknown> = Promise.resolve()

		act(() => {
			done = result.current.apply({ type: "addSheet", name: "S" })
		})
		expect(result.current.pending).toBe(true)

		await act(async () => {
			answer({ type: "none", state: { dirty: true, canUndo: true, canRedo: false } })
			await done
		})
		expect(result.current.pending).toBe(false)
		expect(result.current.state.dirty).toBe(true)
	})
})
