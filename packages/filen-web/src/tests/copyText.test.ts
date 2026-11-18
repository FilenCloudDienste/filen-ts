import { afterEach, describe, expect, it, vi } from "vitest"

const { toastSuccess, toastError } = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastError: vi.fn() }))

vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError } }))
vi.mock("@/lib/i18n/errorLabel", () => ({ errorLabel: (e: unknown) => (e instanceof Error ? e.message : "unknown") }))

import { copyText, copyTextLater } from "@/lib/copyText"

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
		vi.stubGlobal(
			"ClipboardItem",
			class {
				item: Promise<Blob>

				constructor(data: Record<string, Promise<Blob>>) {
					this.item = data["text/plain"] ?? Promise.reject(new Error("no text/plain"))
				}
			}
		)
		vi.stubGlobal("navigator", { clipboard: { write, writeText: vi.fn() } })

		await expect(copyTextLater(Promise.resolve(null), messages)).resolves.toBe(false)
		expect(write).toHaveBeenCalledTimes(1)
		expect(toastError).toHaveBeenCalledWith("Couldn't copy")
	})
})
