// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, waitFor } from "@testing-library/react"
import "@/lib/i18n"
import { linkedFileItem } from "@/tests/fixtures/sdk"

// docx-preview mints an object URL per embedded image and font and never revokes one; the viewer
// owns that, once the render it belongs to is gone.

const { renderAsync } = vi.hoisted(() => ({
	renderAsync: vi.fn<(bytes: Uint8Array, host: HTMLElement) => Promise<void>>()
}))

vi.mock("docx-preview", () => ({ renderAsync }))
vi.mock("@/features/preview/hooks/usePreviewBytes", () => ({
	usePreviewBytes: () => ({ status: "success", bytes: new Uint8Array([1]), refetch: () => undefined })
}))

const { DocxViewer } = await import("@/features/preview/components/docxViewer")

const item = linkedFileItem("doc.docx", {
	uuid: "aaaaaaaa-0000-0000-0000-000000000001",
	mime: { Decrypted: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
	size: 1n
})

const revokeObjectURL = vi.fn<(url: string) => void>()

beforeEach(() => {
	URL.revokeObjectURL = revokeObjectURL
})

afterEach(() => {
	revokeObjectURL.mockReset()
})

function paint(host: HTMLElement): void {
	host.innerHTML = `<style>@font-face { src: url(blob:https://app/font) }</style><img src="blob:https://app/img">`
}

describe("DocxViewer object URLs", () => {
	it("keeps them while the document is shown and revokes them on unmount", async () => {
		renderAsync.mockImplementation((_bytes, host) => {
			paint(host)

			return Promise.resolve()
		})

		const view = render(
			<DocxViewer
				item={item}
				alt="doc.docx"
			/>
		)

		await waitFor(() => {
			expect(view.container.querySelector("img")).not.toBeNull()
		})

		expect(revokeObjectURL).not.toHaveBeenCalled()

		view.unmount()

		expect(revokeObjectURL.mock.calls.map(([url]) => url).sort()).toEqual(["blob:https://app/font", "blob:https://app/img"])
	})

	it("revokes right away the URLs of a render that finishes after unmount", async () => {
		let finish: () => void = () => undefined
		renderAsync.mockImplementation(
			(_bytes, host) =>
				new Promise<void>(resolve => {
					finish = () => {
						paint(host)
						resolve()
					}
				})
		)

		const view = render(
			<DocxViewer
				item={item}
				alt="doc.docx"
			/>
		)

		await waitFor(() => {
			expect(renderAsync).toHaveBeenCalled()
		})

		view.unmount()
		finish()

		await waitFor(() => {
			expect(revokeObjectURL).toHaveBeenCalledTimes(2)
		})
	})
})
