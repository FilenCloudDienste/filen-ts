import { describe, expect, it } from "vitest"
import * as mupdf from "mupdf"
import { pdfExternalLink, pdfLinks } from "../../dom/pdf/links"
import { pageTextLinks } from "../../dom/pdfedit/text"

// Links read by the editor's engine pass the same gate as the viewer's (pdfExternalLink): only what the shared link
// policy allows becomes navigable, whatever the document's action says.

const HOSTILE = [
	"javascript:alert(1)",
	" JaVaScRiPt:alert(1)",
	"java\tscript:alert(1)",
	"\u0000javascript:alert(1)",
	"\u0001javascript:alert(1)",
	"data:text/html,<script>alert(1)</script>",
	"vbscript:msgbox(1)",
	"file:///etc/passwd",
	"blob:https://filen.io/0f3c",
	"x-custom-app://open",
	"ms-settings:display",
	"intent://scan#Intent;end",
	"relative/path.html",
	"/absolute/path",
	"//protocol-relative.example",
	"https:/missing-host",
	"tel:+1\njavascript:alert(1)",
	""
]

function hostilePdf(): Uint8Array {
	const document = new mupdf.PDFDocument()

	document.insertPage(-1, document.addPage([0, 0, 595, 842], 0, document.addObject({}), ""))
	document.insertPage(-1, document.addPage([0, 0, 595, 842], 0, document.addObject({}), ""))

	const page = document.findPage(0)
	const second = document.findPage(1)
	const string = (value: string) => document.newString(value)
	const link = (index: number, action: Record<string, unknown>) =>
		document.addObject({ Type: "Annot", Subtype: "Link", Rect: [10, 10 + index * 20, 100, 25 + index * 20], A: action })
	const annots = HOSTILE.map((uri, index) => link(index, { S: "URI", URI: string(uri) }))

	annots.push(
		link(HOSTILE.length, { S: "GoToR", F: string("other.pdf"), D: [0, document.newName("Fit")] }),
		link(HOSTILE.length + 1, { S: "Launch", F: string("calc.exe") }),
		link(HOSTILE.length + 2, { S: "JavaScript", JS: string("app.alert(1)") }),
		link(HOSTILE.length + 3, { S: "URI", URI: string("https://filen.io/safe") }),
		link(HOSTILE.length + 4, { S: "GoTo", D: [second, document.newName("XYZ"), 0, 700, 0] })
	)
	page.put("Annots", annots)

	const bytes = document.saveToBuffer("").asUint8Array().slice()

	document.destroy()

	return bytes
}

describe("PDF link gate", () => {
	it("allows only the shared policy's links", () => {
		for (const uri of HOSTILE) expect(pdfExternalLink(uri)).toBeNull()

		expect(pdfExternalLink("https://filen.io/x")).toBe("https://filen.io/x")
		expect(pdfExternalLink("  mailto:a@b.c ")).toBe("mailto:a@b.c")
		expect(pdfExternalLink("https://filen.io/x", () => false)).toBeNull()
		expect(pdfExternalLink(42)).toBeNull()
	})

	it("keeps hostile links of the engine out of the viewer", () => {
		const document = mupdf.Document.openDocument(hostilePdf(), "application/pdf").asPDF()

		if (document === null) throw new Error("not a PDF")

		const page = document.loadPage(0)

		if (!(page instanceof mupdf.PDFPage)) throw new Error("not a PDF page")

		const links = pageTextLinks(document, page, index => (index === 1 ? [0, 0, 595, 842] : null))

		expect(links).toEqual([
			{ rect: [10, 10 + (HOSTILE.length + 3) * 20, 100, 25 + (HOSTILE.length + 3) * 20], url: "https://filen.io/safe" },
			{ rect: [10, 10 + (HOSTILE.length + 4) * 20, 100, 25 + (HOSTILE.length + 4) * 20], page: 1, left: 0, top: 700 }
		])

		// As the viewer reads them (pdf.js-shaped annotations), the same.
		const annotations = links.map(link => ("url" in link ? { subtype: "Link", rect: link.rect, url: link.url } : null))

		expect(pdfLinks(annotations.filter(entry => entry !== null)).map(link => link.kind)).toEqual(["external"])

		page.destroy()
		document.destroy()
	})
})
