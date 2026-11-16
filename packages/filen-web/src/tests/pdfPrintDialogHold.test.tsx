// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { PdfDomDocument } from "@filen/office/react/pdf"
import "@/lib/i18n"

// Every print job holds the viewer's document while its pages render, whatever pages it prints: the viewer would
// otherwise reopen the document under the job once it read past its resident limit.

const job = vi.hoisted(() => ({ finish: (): void => undefined }))

vi.mock("@/features/pdf/print/pdfPrint", () => ({
	printPdf: () =>
		new Promise<void>(resolve => {
			job.finish = resolve
		})
}))

const { PdfPrintDialog } = await import("@/features/pdf/print/pdfPrintDialog")

const page = { getViewport: () => ({ width: 595, height: 842 }) }
const document = { numPages: 80, getPage: () => Promise.resolve(page) } as unknown as PdfDomDocument

afterEach(() => {
	cleanup()
})

describe("PdfPrintDialog hold", () => {
	it.each([
		["the page in view", "Current page (3)"],
		["every page", "All"]
	])("holds the document while printing %s, and lets go once done", async (_case, choice) => {
		const release = vi.fn()
		const hold = vi.fn(() => release)

		render(
			<PdfPrintDialog
				document={document}
				current={3}
				size={1024}
				permissions={{ print: true, highQuality: true }}
				constrained={false}
				fullRead={{ confirm: () => Promise.resolve(true), hold }}
				onClose={() => undefined}
			/>
		)

		fireEvent.click(screen.getByRole("radio", { name: choice }))
		fireEvent.click(screen.getByRole("button", { name: "Print…" }))
		expect(hold).toHaveBeenCalledTimes(1)
		expect(release).not.toHaveBeenCalled()

		await act(async () => {
			job.finish()
			await Promise.resolve()
		})
		expect(release).toHaveBeenCalledTimes(1)
	})
})
