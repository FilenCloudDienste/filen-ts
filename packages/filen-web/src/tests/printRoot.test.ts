// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"

// The shared print root: one sheet per page at the page's size, shown to the printer alone, removed with its
// stylesheet and blob URLs once the dialog closes, an abort or a failure.

const { createPrintRoot } = await import("@/lib/print/printRoot")

afterEach(() => {
	vi.restoreAllMocks()
	document.head.replaceChildren()
	document.body.replaceChildren()
})

function stubPrint(): { readonly print: ReturnType<typeof vi.fn> } {
	const print = vi.fn(() => {
		expect(document.querySelector(".fo-print-root")).not.toBeNull()
		window.dispatchEvent(new Event("afterprint"))
	})

	vi.spyOn(window, "print").mockImplementation(print)

	return { print }
}

describe("the print root", () => {
	it("prints one sheet per page, named by size, and removes everything afterwards", async () => {
		const { print } = stubPrint()
		const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)
		const root = createPrintRoot()

		root.addPage({ width: 595, height: 842, unit: "pt" }).append(document.createElement("canvas"))
		root.addPage({ width: 842, height: 595, unit: "pt" })
		root.addPage({ width: 595, height: 842, unit: "pt" })
		root.keepUrl("blob:one")

		let seen: { pages: string[]; css: string } | null = null

		print.mockImplementation(() => {
			seen = {
				pages: [...document.querySelectorAll<HTMLElement>(".fo-print-root > .fo-print-page")].map(
					page => `${page.style.getPropertyValue("page")} ${page.style.width}x${page.style.height}`
				),
				css: [...document.head.querySelectorAll("style")].map(style => style.textContent).join("")
			}
			window.dispatchEvent(new Event("afterprint"))
		})

		await root.print()

		expect(seen).toEqual({
			pages: ["fo-print-pt-59500x84200 595ptx842pt", "fo-print-pt-84200x59500 842ptx595pt", "fo-print-pt-59500x84200 595ptx842pt"],
			css:
				"@page { size: 595pt 842pt; margin: 0 }" +
				"@page fo-print-pt-59500x84200{ size: 595pt 842pt; margin: 0 }" +
				"@page fo-print-pt-84200x59500{ size: 842pt 595pt; margin: 0 }"
		})
		expect(document.querySelector(".fo-print-root")).toBeNull()
		expect(document.head.querySelector("style")).toBeNull()
		expect(revoke).toHaveBeenCalledWith("blob:one")
	})

	it("opens no dialog and cleans up when aborted before it", async () => {
		const { print } = stubPrint()
		const controller = new AbortController()
		const root = createPrintRoot()

		root.addPage({ width: 10, height: 10, unit: "px" })
		controller.abort(new Error("cancelled"))

		await expect(root.print({ signal: controller.signal })).rejects.toThrow("cancelled")
		expect(print).not.toHaveBeenCalled()
		expect(document.querySelector(".fo-print-root")).toBeNull()
	})

	it("revokes a URL kept after disposal at once", () => {
		const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)
		const root = createPrintRoot()

		root.dispose()
		root.keepUrl("blob:late")

		expect(revoke).toHaveBeenCalledWith("blob:late")
	})

	it("removes the root after a while when afterprint never fires", async () => {
		vi.useFakeTimers()
		vi.spyOn(window, "print").mockImplementation(() => undefined)

		const root = createPrintRoot()

		root.addPage({ width: 10, height: 10, unit: "px" })

		const printed = root.print()

		await vi.advanceTimersByTimeAsync(60_000)
		await printed
		expect(document.querySelector(".fo-print-root")).toBeNull()
		vi.useRealTimers()
	})
})
