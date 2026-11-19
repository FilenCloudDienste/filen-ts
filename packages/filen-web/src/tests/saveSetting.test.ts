import { beforeEach, describe, expect, it, vi } from "vitest"

const { warn, toastError } = vi.hoisted(() => ({ warn: vi.fn(), toastError: vi.fn() }))

vi.mock("@/lib/log", () => ({ log: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock("sonner", () => ({ toast: { error: toastError } }))
vi.mock("@/lib/i18n", () => ({ i18n: { t: (key: string) => key } }))

import { saveSetting } from "@/lib/saveSetting"

beforeEach(() => {
	warn.mockClear()
	toastError.mockClear()
})

describe("saveSetting", () => {
	it("resolves true for a stored write, with no log or toast", async () => {
		const write = vi.fn(() => Promise.resolve())

		await expect(saveSetting(write)).resolves.toBe(true)
		expect(write).toHaveBeenCalledOnce()
		expect(warn).not.toHaveBeenCalled()
		expect(toastError).not.toHaveBeenCalled()
	})

	it("resolves false for a rejecting write: logged, toasted, never rethrown", async () => {
		await expect(saveSetting(() => Promise.reject(new Error("quota exceeded")))).resolves.toBe(false)
		expect(warn).toHaveBeenCalledWith("settings", "setting write failed", "quota exceeded")
		expect(toastError).toHaveBeenCalledWith("settings:settingsDocumentsSaveFailed")
	})

	it("catches a synchronous throw as well", async () => {
		await expect(
			saveSetting(() => {
				throw new Error("worker gone")
			})
		).resolves.toBe(false)
		expect(toastError).toHaveBeenCalledOnce()
	})
})
