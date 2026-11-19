import { describe, expect, it, vi } from "vitest"

// Add to dictionary from a document applies at once and reports a failed save like the Settings dialog does.
const { add, toast, logWarn } = vi.hoisted(() => ({
	add: vi.fn<(word: string) => Promise<void>>(),
	toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }),
	logWarn: vi.fn()
}))

vi.mock("sonner", () => ({ toast }))
vi.mock("@/lib/log", () => ({ log: { warn: logWarn, error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock("@/lib/appUpdate", () => ({ recoverIfNewerBuild: () => undefined }))
vi.mock("@/features/spellcheck/workers/spellcheck.worker.ts?worker", () => ({ default: vi.fn() }))
vi.mock("@/features/spellcheck/lib/userDictionary", () => ({
	userDictionary: {
		add,
		words: () => [],
		subscribe: () => () => undefined,
		load: () => Promise.resolve()
	}
}))

const { documentSpellingChecker } = await import("@/features/spellcheck/lib/spellcheck")
const { i18n } = await import("@/lib/i18n")

describe("documentSpellingChecker.addToDictionary", () => {
	it("resolves at once and toasts and logs a failed save once each", async () => {
		let reject: (error: unknown) => void = () => undefined

		add.mockReturnValueOnce(
			new Promise<void>((_, rejectAdd) => {
				reject = rejectAdd
			})
		)

		let resolved = false
		const done = documentSpellingChecker.addToDictionary("filen").then(() => {
			resolved = true
		})

		await done
		expect(resolved).toBe(true)
		expect(add).toHaveBeenCalledWith("filen")
		expect(toast.error).not.toHaveBeenCalled()

		reject(new Error("offline"))
		await vi.waitFor(() => {
			expect(toast.error).toHaveBeenCalledTimes(1)
		})

		expect(toast.error).toHaveBeenCalledWith(i18n.t("settings:settingsDocumentsSaveFailed"))
		expect(logWarn).toHaveBeenCalledTimes(1)
		expect(logWarn.mock.calls[0]?.slice(0, 2)).toEqual(["spellcheck", "user dictionary not saved"])
	})
})
