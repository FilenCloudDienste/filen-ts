// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { render, waitFor } from "@testing-library/react"
import { fakeToolContext } from "@/tests/support/pdfToolContext"
import type { PdfDomDocument } from "@filen/office/react/pdf"
import type { PdfEditSessionModel } from "@filen/office/react/pdfedit"

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => key,
		i18n: { language: "en" }
	})
}))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve()
}))

const { OcrPanel } = await import("@/features/pdf/ocr/ocrPanel")

interface ScanCall {
	readonly args: { readonly from?: number; readonly count?: number }
	resolve(value: { readonly scanned: readonly number[]; readonly pageCount: number }): void
}

// An editor whose scan requests wait until the test answers them.
function scanningContext(calls: ScanCall[]) {
	const session = {
		engine: {
			call: (op: string, args: ScanCall["args"]) => {
				if (op !== "ocrScan") return Promise.reject(new Error(`unexpected ${op}`))

				return new Promise(resolve => {
					calls.push({ args, resolve })
				})
			}
		},
		getSnapshot: () => ({ state: { pageCount: 40, tagged: false } })
	} as unknown as PdfEditSessionModel

	const notify = vi.fn()

	return {
		notify,
		context: fakeToolContext({
			edit: change => {
				void change(session)
			},
			notify
		})
	}
}

describe("OcrPanel's scan", () => {
	it("asks for the scanned pages in runs and stops asking once the panel closes", async () => {
		const calls: ScanCall[] = []
		const { context, notify } = scanningContext(calls)
		const view = render(
			<OcrPanel
				context={context}
				document={{} as PdfDomDocument}
				active
				phone={false}
			/>
		)

		await waitFor(() => {
			expect(calls).toHaveLength(1)
		})
		expect(calls[0]?.args.from).toBe(0)

		const count = calls[0]?.args.count ?? 0

		expect(count).toBeGreaterThan(0)
		expect(count).toBeLessThan(40)
		calls[0]?.resolve({ scanned: [1], pageCount: 40 })

		await waitFor(() => {
			expect(calls).toHaveLength(2)
		})
		expect(calls[1]?.args.from).toBe(count)

		view.unmount()
		calls[1]?.resolve({ scanned: [], pageCount: 40 })
		await new Promise(resolve => setTimeout(resolve, 20))

		expect(calls).toHaveLength(2)
		expect(notify).not.toHaveBeenCalled()
	})
})
