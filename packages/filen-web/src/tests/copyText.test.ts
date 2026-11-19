import { afterEach, describe, expect, it, vi } from "vitest"

const { toastSuccess, toastError } = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastError: vi.fn() }))

vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError } }))
vi.mock("@/lib/i18n/errorLabel", () => ({ errorLabel: (e: unknown) => (e instanceof Error ? e.message : "unknown") }))

import { copyText, copyTextLater } from "@/lib/copyText"

// Keeps the text promise a ClipboardItem was made with, as `item`, for a write stub to await.
class ClipboardItemStub {
	item: Promise<Blob>

	constructor(data: Record<string, Promise<Blob>>) {
		this.item = data["text/plain"] ?? Promise.reject(new Error("no text/plain"))
	}
}

afterEach(() => {
	vi.unstubAllGlobals()
	vi.clearAllMocks()
})

describe("copyText", () => {
	it("writes the text, toasts success and resolves true", async () => {
		const writeText = vi.fn(() => Promise.resolve())
		vi.stubGlobal("navigator", { clipboard: { writeText } })

		await expect(copyText("abc", "Copied")).resolves.toBe(true)
		expect(writeText).toHaveBeenCalledWith("abc")
		expect(toastSuccess).toHaveBeenCalledWith("Copied")
		expect(toastError).not.toHaveBeenCalled()
	})

	it("toasts the error label and resolves false when the write is refused", async () => {
		vi.stubGlobal("navigator", { clipboard: { writeText: () => Promise.reject(new Error("denied")) } })

		await expect(copyText("abc", "Copied")).resolves.toBe(false)
		expect(toastSuccess).not.toHaveBeenCalled()
		expect(toastError).toHaveBeenCalledWith("denied")
	})
})

describe("copyTextLater", () => {
	const messages = { copied: "Copied", failed: "Couldn't copy" }

	it("writes the text once it arrives", async () => {
		const writeText = vi.fn(() => Promise.resolve())
		vi.stubGlobal("navigator", { clipboard: { writeText } })

		await expect(copyTextLater(Promise.resolve("abc"), messages)).resolves.toBe(true)
		expect(writeText).toHaveBeenCalledWith("abc")
		expect(toastSuccess).toHaveBeenCalledWith("Copied")
	})

	it("writes nothing and says it failed when no text comes back", async () => {
		const writeText = vi.fn(() => Promise.resolve())
		vi.stubGlobal("navigator", { clipboard: { writeText } })

		await expect(copyTextLater(Promise.resolve(null), messages)).resolves.toBe(false)
		expect(writeText).not.toHaveBeenCalled()
		expect(toastSuccess).not.toHaveBeenCalled()
		expect(toastError).toHaveBeenCalledWith("Couldn't copy")
	})

	it("gives up on text that never comes, and says so", async () => {
		vi.useFakeTimers()

		try {
			const writeText = vi.fn(() => Promise.resolve())
			vi.stubGlobal("navigator", { clipboard: { writeText } })

			const copied = copyTextLater(new Promise<string>(() => undefined), messages, 1000)

			await vi.advanceTimersByTimeAsync(1000)
			await expect(copied).resolves.toBe(false)
			expect(writeText).not.toHaveBeenCalled()
			expect(toastError).toHaveBeenCalledWith("Couldn't copy")
		} finally {
			vi.useRealTimers()
		}
	})

	it("hands the clipboard a promise where it takes one, failing the write on no text", async () => {
		const write = vi.fn(async (items: { item: Promise<Blob> }[]) => {
			await items[0]?.item
		})
		vi.stubGlobal("ClipboardItem", ClipboardItemStub)
		vi.stubGlobal("navigator", { clipboard: { write, writeText: vi.fn() } })

		await expect(copyTextLater(Promise.resolve(null), messages)).resolves.toBe(false)
		expect(write).toHaveBeenCalledTimes(1)
		expect(toastError).toHaveBeenCalledWith("Couldn't copy")
	})

	it("starts the write before the text arrives and hands the clipboard a text/plain Blob of it", async () => {
		const write = vi.fn(async (items: { item: Promise<Blob> }[]) => {
			await items[0]?.item
		})
		const writeText = vi.fn()
		vi.stubGlobal("ClipboardItem", ClipboardItemStub)
		vi.stubGlobal("navigator", { clipboard: { write, writeText } })

		let resolveText: (text: string) => void = () => undefined
		const copied = copyTextLater(
			new Promise<string>(resolve => {
				resolveText = resolve
			}),
			messages
		)

		expect(write).toHaveBeenCalledTimes(1)

		resolveText("abc")

		await expect(copied).resolves.toBe(true)

		const blob = await write.mock.calls[0]?.[0][0]?.item

		expect(blob).toBeInstanceOf(Blob)
		expect(blob?.type).toBe("text/plain")
		expect(await blob?.text()).toBe("abc")
		expect(writeText).not.toHaveBeenCalled()
		expect(toastSuccess).toHaveBeenCalledWith("Copied")
		expect(toastError).not.toHaveBeenCalled()
	})

	it("toasts the error label and resolves false when the clipboard refuses the write", async () => {
		vi.stubGlobal("ClipboardItem", ClipboardItemStub)
		vi.stubGlobal("navigator", { clipboard: { write: () => Promise.reject(new Error("denied")), writeText: vi.fn() } })

		await expect(copyTextLater(Promise.resolve("abc"), messages)).resolves.toBe(false)
		expect(toastSuccess).not.toHaveBeenCalled()
		expect(toastError).toHaveBeenCalledWith("denied")
	})

	describe("when the browser replaces a failed item promise's error with its own", () => {
		function stubReplacingClipboard() {
			vi.stubGlobal("ClipboardItem", ClipboardItemStub)
			vi.stubGlobal("navigator", {
				clipboard: {
					write: async (items: { item: Promise<Blob> }[]) => {
						try {
							await items[0]?.item
						} catch {
							throw new Error("NotAllowedError")
						}
					},
					writeText: vi.fn()
				}
			})
		}

		it("still says the text did not come", async () => {
			stubReplacingClipboard()

			await expect(copyTextLater(Promise.resolve(null), messages)).resolves.toBe(false)
			expect(toastError).toHaveBeenCalledWith("Couldn't copy")
		})

		it("says the text source's own error", async () => {
			stubReplacingClipboard()

			await expect(copyTextLater(Promise.reject(new Error("worker failed")), messages)).resolves.toBe(false)
			expect(toastError).toHaveBeenCalledWith("worker failed")
		})

		it("runs a failed callback instead of a toast", async () => {
			stubReplacingClipboard()
			const failed = vi.fn()

			await expect(copyTextLater(Promise.resolve(null), { copied: "Copied", failed })).resolves.toBe(false)
			expect(failed).toHaveBeenCalledTimes(1)
			expect(toastError).not.toHaveBeenCalled()
		})
	})
})
