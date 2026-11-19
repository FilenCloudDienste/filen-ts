// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import type { SheetOpened, SheetOpenResult } from "@filen/office/core/sheet"
import type { DriveItem } from "@/features/drive/lib/item"

// A spreadsheet that fails to open shows one text, so the diagnostic log is what tells the reasons apart.

const mocks = vi.hoisted(() => {
	const result: { current: SheetOpenResult | Error } = { current: { kind: "aborted" } }

	// One buffer across renders, as the preview cache holds it.
	const digit: { current: () => Promise<SheetOpened> } = { current: () => Promise.reject(new Error("unset")) }

	return { bytes: new Uint8Array([1, 2, 3]), result, digit, warn: vi.fn() }
})

vi.mock("@/lib/log", () => ({ log: { warn: mocks.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

vi.mock("@/features/preview/hooks/usePreviewBytes", () => ({
	usePreviewBytes: () => ({ status: "success", bytes: mocks.bytes, refetch: () => undefined })
}))

vi.mock("@/features/spreadsheet/lib/sheetHosts", () => ({
	openSheet: () => {
		const result = mocks.result.current

		return result instanceof Error ? Promise.reject(result) : Promise.resolve(result)
	}
}))

vi.mock("@/features/spreadsheet/lib/sheetDigitWidth", () => ({
	withWorkbookDigit: () => mocks.digit.current()
}))

const { useSheetSession } = await import("@/features/spreadsheet/hooks/useSheetSession")

const item = { type: "file", data: { uuid: "u-book", decryptedMeta: { name: "book.xlsx" }, size: 3n } } as unknown as DriveItem

describe("useSheetSession open failures", () => {
	it("logs the worker's reason and message when the open fails", async () => {
		mocks.warn.mockClear()
		mocks.result.current = { kind: "failed", reason: "tooLarge", message: "archive limit" }

		const { result } = renderHook(() => useSheetSession(item, "failed"))

		await waitFor(() => {
			expect(result.current.status).toBe("unreadable")
		})
		expect(mocks.warn).toHaveBeenCalledWith("preview", "spreadsheet open failed", "tooLarge", "archive limit")
	})

	it("logs the error when the open rejects", async () => {
		mocks.warn.mockClear()
		const error = new Error("worker script failed to load")

		mocks.result.current = error

		const { result } = renderHook(() => useSheetSession(item, "rejected"))

		await waitFor(() => {
			expect(result.current.status).toBe("unreadable")
		})
		expect(mocks.warn).toHaveBeenCalledWith("preview", "spreadsheet open failed", "worker script failed to load")
	})

	it("logs nothing for an aborted open", async () => {
		mocks.warn.mockClear()
		mocks.result.current = { kind: "aborted" }

		const { result } = renderHook(() => useSheetSession(item, "aborted"))

		await waitFor(() => {
			expect(result.current.status).toBe("unreadable")
		})
		expect(mocks.warn).not.toHaveBeenCalled()
	})

	it("logs a digit width failure while open and still shows the workbook", async () => {
		mocks.warn.mockClear()
		mocks.result.current = opened(vi.fn())
		mocks.digit.current = () => Promise.reject(new Error("font metrics failed"))

		const { result } = renderHook(() => useSheetSession(item, "digit-failed"))

		await waitFor(() => {
			expect(result.current.status).toBe("ready")
		})
		expect(mocks.warn).toHaveBeenCalledWith("preview", "spreadsheet digit width failed", "font metrics failed")
	})

	it("logs nothing when the digit width query ends because the viewer closed", async () => {
		mocks.warn.mockClear()
		const close = vi.fn()
		let reject: (error: Error) => void = () => undefined
		let asked = false

		mocks.result.current = opened(close)
		mocks.digit.current = () => {
			asked = true

			return new Promise<SheetOpened>((_resolve, fail) => {
				reject = fail
			})
		}

		const { unmount } = renderHook(() => useSheetSession(item, "digit-closed"))

		await waitFor(() => {
			expect(asked).toBe(true)
		})
		unmount()
		reject(new Error("session closed"))
		await new Promise(resolve => setTimeout(resolve, 0))

		expect(close).toHaveBeenCalled()
		expect(mocks.warn).not.toHaveBeenCalled()
	})
})

// An opened workbook with just what the hook reads; `close` stands for the session's.
function opened(close: () => void): SheetOpenResult {
	return { kind: "opened", info: { kind: "xlsx" }, session: { close } } as unknown as SheetOpenResult
}
