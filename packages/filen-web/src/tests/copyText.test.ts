import { afterEach, describe, expect, it, vi } from "vitest"

const { toastSuccess, toastError } = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastError: vi.fn() }))

vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError } }))
vi.mock("@/lib/i18n/errorLabel", () => ({ errorLabel: (e: unknown) => (e instanceof Error ? e.message : "unknown") }))

import { copyText } from "@/lib/copyText"

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
