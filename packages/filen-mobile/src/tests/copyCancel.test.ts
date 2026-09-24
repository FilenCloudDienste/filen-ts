import { vi, describe, it, expect, beforeEach } from "vitest"
import i18next, { type TFunction } from "i18next"
import { en } from "@/locales/en"

vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

const h = vi.hoisted(() => ({
	confirm3: vi.fn(),
	alertError: vi.fn(),
	hold: vi.fn(),
	resolve: vi.fn(),
	job: undefined as { phase: string; counts: { filesDone: number }; totals: { files: number } } | undefined
}))

vi.mock("@/lib/prompts", () => ({ default: { confirm3: h.confirm3 } }))
vi.mock("@/lib/alerts", () => ({ default: { error: h.alertError } }))
vi.mock("@/features/copy/copyRunner", () => ({ default: { holdForCancelChoice: h.hold, resolveCancelChoice: h.resolve } }))
vi.mock("@/features/copy/store/useCopyJobs.store", () => ({ getCopyJob: () => h.job }))

import { stopCopyWithChoice } from "@/features/copy/copyCancel"

const t = ((key: string, options?: Record<string, unknown>) =>
	options ? `${key}:${JSON.stringify(options)}` : key) as unknown as TFunction

beforeEach(() => {
	h.confirm3.mockReset()
	h.alertError.mockReset()
	h.hold.mockReset().mockReturnValue(true)
	h.resolve.mockReset().mockResolvedValue(undefined)
	h.job = { phase: "copyingFiles", counts: { filesDone: 340 }, totals: { files: 812 } }
})

describe("stopCopyWithChoice", () => {
	it("holds the copy, then asks with the copied count", async () => {
		h.confirm3.mockResolvedValue("cancel")

		await stopCopyWithChoice("job", t)

		expect(h.hold).toHaveBeenCalledWith("job")
		expect(h.hold.mock.invocationCallOrder[0]).toBeLessThan(h.confirm3.mock.invocationCallOrder[0] ?? 0)
		expect(h.confirm3).toHaveBeenCalledExactlyOnceWith({
			title: "copy_stop_title",
			message: 'copy_stop_message:{"done":340,"count":812}',
			primaryText: "copy_stop_keep",
			destructiveText: "copy_stop_trash",
			cancelText: "copy_continue"
		})
	})

	it("reads one file in the singular", async () => {
		const english = i18next.createInstance()

		await english.init({
			resources: {
				en: {
					translation: en
				}
			},
			lng: "en",
			keySeparator: false,
			nsSeparator: false,
			interpolation: {
				escapeValue: false
			}
		})

		h.job = { phase: "copyingFiles", counts: { filesDone: 0 }, totals: { files: 1 } }
		h.confirm3.mockResolvedValue("cancel")

		await stopCopyWithChoice("job", english.t.bind(english) as unknown as TFunction)

		expect(h.confirm3.mock.calls[0]?.[0]).toMatchObject({ message: "0 of 1 file is already copied." })
	})

	it.each([
		["while the scan is still totalling", { phase: "scanning", counts: { filesDone: 0 }, totals: { files: 12 } }],
		["for a copy without files", { phase: "creatingDirectories", counts: { filesDone: 0 }, totals: { files: 0 } }]
	])("asks without a count %s", async (_label, job) => {
		h.job = job
		h.confirm3.mockResolvedValue("cancel")

		await stopCopyWithChoice("job", t)

		expect(h.confirm3.mock.calls[0]?.[0]).toMatchObject({ message: undefined })
	})

	it.each([
		["primary", "keep"],
		["destructive", "trash"],
		["cancel", "continue"]
	] as const)("%s answers %s", async (answer, choice) => {
		h.confirm3.mockResolvedValue(answer)

		await stopCopyWithChoice("job", t)

		expect(h.resolve).toHaveBeenCalledExactlyOnceWith("job", choice, true)
	})

	it("passes on whether the dialog paused the copy", async () => {
		h.hold.mockReturnValue(false)
		h.confirm3.mockResolvedValue("cancel")

		await stopCopyWithChoice("job", t)

		expect(h.resolve).toHaveBeenCalledExactlyOnceWith("job", "continue", false)
	})

	it("a failed dialog shows the error and lets the copy go on", async () => {
		const error = new Error("no dialog")

		h.confirm3.mockRejectedValue(error)

		await stopCopyWithChoice("job", t)

		expect(h.alertError).toHaveBeenCalledWith(error)
		expect(h.resolve).toHaveBeenCalledExactlyOnceWith("job", "continue", true)
	})

	it("asks without a count when the job is gone", async () => {
		h.job = undefined
		h.confirm3.mockResolvedValue("cancel")

		await stopCopyWithChoice("job", t)

		expect(h.confirm3.mock.calls[0]?.[0]).toMatchObject({ message: undefined })
	})
})
