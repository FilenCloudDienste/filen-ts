// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import "@/lib/i18n"
import type { PdfDomDocument } from "@filen/office/react/pdf"
import { narrowItem } from "@/features/drive/lib/item"
import { PdfPagesController } from "@/features/pdf/pages/pagesController"
import { PdfExtractPanel } from "@/features/pdf/pages/pagesSurface"
import { PdfPagesSurfaceContext, type PdfPagesSurfaceValue } from "@/features/pdf/pages/pagesSurfaceContext"
import type { PdfToolContext } from "@/features/pdf/tools/registry"
import { mockSharedFile } from "@/tests/fixtures/sdk"

// The Extract dialog's name preview reads the names beside the PDF from the tool host (the directory the copies are
// written to), for every kind of item: a shared file's are its own directory's, never the drive root's.

describe("the names the Extract dialog shows", () => {
	it("are free among the names the tool host reads for a shared file", async () => {
		const item = narrowItem(
			mockSharedFile({
				meta: {
					type: "decoded",
					data: { name: "shared.pdf", mime: "application/pdf", modified: 1_700_000_000_000n, size: 2_048n, key: "k", version: 2 }
				}
			})
		)
		const takenNames = vi.fn(() => Promise.resolve(new Set(["shared (page 1).pdf"])))
		const controller = new PdfPagesController()

		controller.sync(3)
		controller.select(new Set([0]))

		const surface = {
			controller,
			document: { numPages: 3 } as unknown as PdfDomDocument,
			engine: null,
			snapshot: null,
			item,
			policy: { editable: true, online: true, tools: null, poisoned: false },
			toolContext: { edit: () => undefined, host: { takenNames } } as unknown as PdfToolContext,
			viewRotation: 0,
			online: true,
			ranged: false
		} satisfies PdfPagesSurfaceValue

		expect(item.type).not.toBe("file")

		render(
			<PdfPagesSurfaceContext value={surface}>
				<PdfExtractPanel onClose={() => undefined} />
			</PdfPagesSurfaceContext>
		)

		await waitFor(() => {
			expect(screen.getByText(/shared \(page 1 2\)\.pdf/)).toBeTruthy()
		})
		expect(takenNames).toHaveBeenCalledTimes(1)
	})
})
