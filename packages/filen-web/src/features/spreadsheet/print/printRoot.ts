import { printPageAt, renderPrintPage, type PrintRenderOptions } from "@filen/office/react/sheet/print"
import { createPrintRoot } from "@/lib/print/printRoot"

// The printable pages: SVG elements, one per sheet of paper of the page's size, in the shared print root
// (lib/print/printRoot.ts).

const SVG = "http://www.w3.org/2000/svg"

export interface PrintedPage {
	readonly svg: string
	// Points.
	readonly width: number
	readonly height: number
}

// One measure for the print's text, from a canvas as the grid measures with.
export function canvasMeasure(): (font: string, text: string) => number {
	const context = document.createElement("canvas").getContext("2d")
	let current = ""

	return (font, text) => {
		if (context === null) return text.length * 7

		if (current !== font) {
			context.font = font
			current = font
		}

		return context.measureText(text).width
	}
}

// A page's markup as an element. The markup is our own, every text in it escaped; it is read as XML, so anything
// malformed fails here rather than reaching the document.
export function svgElement(markup: string): SVGSVGElement | null {
	const parsed = new DOMParser().parseFromString(markup, "image/svg+xml")
	const root = parsed.documentElement

	if (root.namespaceURI !== SVG || root.localName !== "svg" || parsed.getElementsByTagName("parsererror").length > 0) return null

	return document.importNode(root, true) as unknown as SVGSVGElement
}

// The first `total` pages of a print, drawn one after another (each a few milliseconds on the main thread).
export async function renderPages(options: PrintRenderOptions, total: number, progress: (done: number) => void): Promise<PrintedPage[]> {
	const out: PrintedPage[] = []

	for (let k = 0; k < total; k++) {
		const svg = await renderPrintPage(options, k)
		const at = printPageAt(options.job, k)

		if (svg !== null && at !== null) out.push({ svg, width: at.sheet.pagination.paper.width, height: at.sheet.pagination.paper.height })

		progress(k + 1)
	}

	return out
}

// Prints `pages`; resolves once the print dialog closed.
export async function printPages(pages: readonly PrintedPage[]): Promise<void> {
	const root = createPrintRoot()

	for (const page of pages) {
		const element = svgElement(page.svg)

		if (element !== null) root.addPage({ width: page.width, height: page.height, unit: "pt" }).append(element)
	}

	await root.print()
}
