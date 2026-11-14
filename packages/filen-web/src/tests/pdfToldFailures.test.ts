import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PdfEditSessionModel } from "@filen/office/react/pdfedit"

// Failures of an undo, a redo or an attachment download are told and logged, never swallowed.

const toastError = vi.fn()
const logError = vi.fn()
const downloadBlob = vi.fn()

vi.mock("sonner", () => ({ toast: { error: toastError } }))
vi.mock("@/lib/log", () => ({ log: { error: logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock("@/lib/downloadBlob", () => ({ downloadBlob }))
vi.mock("@/lib/keymap/kbd.logic", () => ({ isMacPlatform: () => false }))

const { historyStep } = await import("@/features/pdf/session/toolSession")
const { downloadAttachmentTold } = await import("@/features/pdf/annotations/attachments")

const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const WORDS = { failed: "failed", missing: "missing" }
const SOURCE = { kind: "document", key: "a" } as const

function session(attachment: () => Promise<Uint8Array | null>): PdfEditSessionModel {
	return {
		engine: {
			call: (op: string) => (op === "attachment" ? attachment() : Promise.resolve([{ source: SOURCE, name: "a.txt", size: 1 }]))
		}
	} as unknown as PdfEditSessionModel
}

beforeEach(() => {
	toastError.mockClear()
	logError.mockClear()
	downloadBlob.mockClear()
})

describe("told failures", () => {
	it("tells and logs an undo or redo that failed", async () => {
		const failure = new Error("engine trap")

		historyStep(() => Promise.reject(failure), "undo", "couldn't undo")
		await flush()
		expect(toastError).toHaveBeenCalledWith("couldn't undo")
		expect(logError).toHaveBeenCalledWith("pdf", "undo failed", { error: failure })

		historyStep(() => Promise.resolve(), "redo", "couldn't redo")
		await flush()
		expect(toastError).toHaveBeenCalledTimes(1)
	})

	it("tells a missing attachment, and tells and logs a failed one", async () => {
		await downloadAttachmentTold(
			session(() => Promise.resolve(null)),
			SOURCE,
			WORDS
		)
		expect(toastError).toHaveBeenLastCalledWith("missing")

		const failure = new Error("read failed")

		await expect(
			downloadAttachmentTold(
				session(() => Promise.reject(failure)),
				SOURCE,
				WORDS
			)
		).resolves.toBeUndefined()
		expect(toastError).toHaveBeenLastCalledWith("failed")
		expect(logError).toHaveBeenCalledWith("pdf", expect.any(String), { error: failure })

		await downloadAttachmentTold(
			session(() => Promise.resolve(new Uint8Array([1]))),
			SOURCE,
			WORDS
		)
		expect(downloadBlob).toHaveBeenCalledTimes(1)
		expect(toastError).toHaveBeenCalledTimes(2)
	})
})
