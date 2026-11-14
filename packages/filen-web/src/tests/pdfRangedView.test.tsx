// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { act, render, renderHook, waitFor } from "@testing-library/react"
import "@/lib/i18n"
import { linkedFileItem } from "@/tests/fixtures/sdk"
import { PDF_FULL_READ_WARN_BYTES } from "@/features/preview/lib/pdfLimits"

// The PDF viewer's ranged source (one range port, block-aligned reads, a port the SDK worker lost turning into a
// retryable error) and its confirmation before reading the whole of a large file.

const { sdk, reader } = vi.hoisted(() => ({
	sdk: {
		openRangePort: vi.fn((_port: MessagePort, _file: unknown, _token: string) => Promise.resolve()),
		openLinkedRangePortAnon: vi.fn((_port: MessagePort, _file: unknown, _token: string) => Promise.resolve()),
		cancelPreviewDownload: vi.fn((_token: string) => Promise.resolve())
	},
	reader: {
		readRange: vi.fn((start: number, end: number, _signal: AbortSignal) => Promise.resolve(new Uint8Array(end - start))),
		close: vi.fn(),
		lost: [] as (() => void)[]
	}
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: sdk }))
vi.mock("@/lib/media/rangePort", () => ({
	rangePortReader: () => ({
		readRange: reader.readRange,
		close: reader.close,
		onLost: (callback: () => void) => {
			reader.lost.push(callback)
		}
	})
}))

const { usePreviewRangeSource, PREVIEW_RANGE_CHUNK, PREVIEW_RANGE_MAX_READ } =
	await import("@/features/preview/hooks/usePreviewRangeSource")
const { usePdfFullReadGuard } = await import("@/features/preview/hooks/usePdfFullReadGuard")

const MIB = 1024 * 1024
const ITEM = linkedFileItem("big.pdf", { size: BigInt(40 * MIB) })

describe("usePreviewRangeSource", () => {
	it("serves block-aligned reads of the file through one port, and closes it on unmount", async () => {
		const { result, unmount } = renderHook(() => usePreviewRangeSource(ITEM))

		await waitFor(() => {
			expect(result.current.status).toBe("success")
		})

		if (result.current.status !== "success") return

		const { source } = result.current

		expect(source).toMatchObject({ kind: "ranges", length: 40 * MIB, chunkSize: PREVIEW_RANGE_CHUNK, maxRead: PREVIEW_RANGE_MAX_READ })
		expect(PREVIEW_RANGE_MAX_READ).toBe(4 * PREVIEW_RANGE_CHUNK)
		expect(sdk.openRangePort).toHaveBeenCalledTimes(1)

		await source.read(MIB, 2 * MIB)

		expect(reader.readRange).toHaveBeenCalledWith(MIB, 3 * MIB, expect.any(AbortSignal))

		const token = sdk.openRangePort.mock.calls[0]?.[2]

		unmount()

		expect(reader.close).toHaveBeenCalledTimes(1)
		expect(sdk.cancelPreviewDownload).toHaveBeenCalledWith(token)
	})

	it("reads a byte prefix as a file of its own", async () => {
		const { result } = renderHook(() => usePreviewRangeSource(ITEM, { limit: 5 * MIB }))

		await waitFor(() => {
			expect(result.current.status).toBe("success")
		})

		expect(result.current.status === "success" ? result.current.source.length : 0).toBe(5 * MIB)
	})

	it("turns a lost port into an error whose retry opens a new one", async () => {
		reader.lost.length = 0

		const { result } = renderHook(() => usePreviewRangeSource(ITEM))

		await waitFor(() => {
			expect(result.current.status).toBe("success")
		})

		act(() => {
			for (const lost of reader.lost) lost()
		})

		expect(result.current.status).toBe("error")

		act(() => {
			if (result.current.status === "error") result.current.refetch()
		})

		await waitFor(() => {
			expect(result.current.status).toBe("success")
		})
		expect(sdk.openRangePort).toHaveBeenCalledTimes(2)
	})
})

describe("usePdfFullReadGuard", () => {
	it("lets a file at or under the threshold read everything without asking", async () => {
		const { result } = renderHook(() => usePdfFullReadGuard(PDF_FULL_READ_WARN_BYTES))

		expect(result.current.needs("find")).toBe(false)
		await expect(result.current.confirm("print")).resolves.toBe(true)
	})

	it("asks once per kind for a larger file and counts the confirmations", async () => {
		const result: { current: ReturnType<typeof usePdfFullReadGuard> } = { current: null as never }

		function Host() {
			result.current = usePdfFullReadGuard(PDF_FULL_READ_WARN_BYTES + 1)

			return result.current.dialog
		}

		render(<Host />)

		expect(result.current.needs("find")).toBe(true)

		let answer: Promise<boolean> = Promise.resolve(false)

		act(() => {
			answer = result.current.confirm("find")
		})

		// A second ask while the dialog is open is answered no.
		await expect(result.current.confirm("print")).resolves.toBe(false)

		const dialog = await waitFor(() => {
			const element = document.querySelector('[role="alertdialog"]')

			expect(element).not.toBeNull()

			return element
		})
		const proceed = [...(dialog?.querySelectorAll("button") ?? [])].find(button => button.textContent === "Continue")

		act(() => {
			proceed?.click()
		})

		await expect(answer).resolves.toBe(true)
		expect(result.current.needs("find")).toBe(false)
		expect(result.current.needs("print")).toBe(true)
		expect(result.current.confirmations).toBe(1)
	})

	it("counts holds until released, once each", () => {
		const { result } = renderHook(() => usePdfFullReadGuard(1))
		let release: () => void = () => undefined

		act(() => {
			release = result.current.hold()
		})
		expect(result.current.holds).toBe(1)

		act(() => {
			release()
			release()
		})
		expect(result.current.holds).toBe(0)
	})
})
