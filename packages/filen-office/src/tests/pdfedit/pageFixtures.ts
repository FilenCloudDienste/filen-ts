import * as mupdf from "mupdf"

// Page-organisation fixtures, written object by object with MuPDF (provenance: this generator; nothing external).
// The organised fixture has 6 pages, each page's text "Page N" as tagged marked content:
// - an outline: "Chapter N" per page, "Chapter 2" holding "Section 2.1" (page 3) as a child;
// - links on page 1 to page 3 (explicit), to page 4 (named in /Dests) and to page 5 (named in the /Names tree);
// - page labels i, ii, then 1, 2, …;
// - a form: "name" (text, page 1), "city" (text, page 3), "choice" (radio, widgets on pages 2 and 4), and a signed
//   signature "approval" on page 4 with a visible appearance (a blue line), SigFlags 3;
// - a structure tree (one P element per page, ParentTree keyed by /StructParents), /MarkInfo /Marked true;
// - /OpenAction going to page 3;
// - a page-level /AA JavaScript action on page 1 and a JavaScript link action on page 2.

export interface OrganisedOptions {
	readonly userPassword?: string
}

function pageContent(index: number): string {
	return `/P <</MCID 0>> BDC BT /F1 24 Tf 72 720 Td (Page ${String(index + 1)}) Tj ET EMC\n0 0 1 rg 72 400 100 50 re f\n`
}

function widget(doc: mupdf.PDFDocument, page: mupdf.PDFObject, rect: number[], extra: Record<string, unknown>): mupdf.PDFObject {
	const made = doc.addObject({ Type: "Annot", Subtype: "Widget", Rect: rect, P: page, F: 4, ...extra })
	let annots = page.get("Annots")

	if (annots.isNull()) {
		annots = doc.newArray()
		page.put("Annots", annots)
	}

	annots.push(made)

	return made
}

function link(doc: mupdf.PDFDocument, page: mupdf.PDFObject, rect: number[], extra: Record<string, unknown>): mupdf.PDFObject {
	const made = doc.addObject({ Type: "Annot", Subtype: "Link", Rect: rect, Border: [0, 0, 0], ...extra })
	let annots = page.get("Annots")

	if (annots.isNull()) {
		annots = doc.newArray()
		page.put("Annots", annots)
	}

	annots.push(made)

	return made
}

function dest(doc: mupdf.PDFDocument, page: mupdf.PDFObject): mupdf.PDFObject {
	const array = doc.newArray()

	array.push(page)
	array.push(doc.newName("Fit"))

	return array
}

export function makeOrganisedPdf(options: OrganisedOptions = {}): Uint8Array {
	const count = 6
	const doc = new mupdf.PDFDocument()
	const font = doc.addSimpleFont(new mupdf.Font("Helvetica"))

	for (let index = 0; index < count; index++) {
		doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, doc.addObject({ Font: { F1: font } }), pageContent(index)))
	}

	const pages = Array.from({ length: count }, (_, index) => doc.findPage(index))
	const page = (index: number): mupdf.PDFObject => {
		const found = pages[index]

		if (found === undefined) throw new Error(`no page ${String(index)}`)

		return found
	}
	const root = doc.getTrailer().get("Root")

	// Outline.
	const outlines = doc.addObject({ Type: "Outlines" })
	const items = pages.map((_, index) => doc.addObject({ Title: doc.newString(`Chapter ${String(index + 1)}`), Parent: outlines }))

	items.forEach((item, index) => {
		item.put("Dest", dest(doc, page(index)))

		const previous = items[index - 1]
		const next = items[index + 1]

		if (previous !== undefined) item.put("Prev", previous)
		if (next !== undefined) item.put("Next", next)
	})

	const chapter2 = items[1]
	const section = doc.addObject({ Title: doc.newString("Section 2.1"), Parent: chapter2 })

	section.put("Dest", dest(doc, page(2)))
	chapter2?.put("First", section)
	chapter2?.put("Last", section)
	chapter2?.put("Count", 1)
	outlines.put("First", items[0])
	outlines.put("Last", items.at(-1))
	outlines.put("Count", count + 1)
	root.put("Outlines", outlines)

	// Named destinations: old-style /Dests and the /Names tree.
	const dests = doc.newDictionary()

	dests.put("toFour", dest(doc, page(3)))
	root.put("Dests", doc.addObject(dests))

	const names = doc.newArray()

	names.push(doc.newString("toFive"))
	names.push(dest(doc, page(4)))
	root.put("Names", { Dests: doc.addObject({ Names: names }) })

	// Links on page 1.
	link(doc, page(0), [72, 600, 200, 620], { Dest: dest(doc, page(2)) })
	link(doc, page(0), [72, 570, 200, 590], { Dest: doc.newName("toFour") })
	link(doc, page(0), [72, 540, 200, 560], { A: { S: "GoTo", D: doc.newString("toFive") } })
	link(doc, page(0), [72, 510, 200, 530], { A: { S: "URI", URI: doc.newString("https://example.com/") } })
	link(doc, page(1), [72, 600, 200, 620], { A: { S: "JavaScript", JS: doc.newString("app.alert(1)") } })
	page(0).put("AA", { O: { S: "JavaScript", JS: doc.newString("app.alert(2)") } })

	// Page labels: i, ii, then 1, 2, ….
	doc.setPageLabels(0, "r", "", 1)
	doc.setPageLabels(2, "D", "", 1)

	// Form.
	const fields = doc.newArray()

	fields.push(widget(doc, page(0), [300, 700, 500, 730], { FT: "Tx", T: doc.newString("name"), V: doc.newString("Ann") }))
	fields.push(widget(doc, page(2), [300, 700, 500, 730], { FT: "Tx", T: doc.newString("city"), V: doc.newString("Rome") }))

	const choice = doc.addObject({ FT: "Btn", Ff: 49152, T: doc.newString("choice"), V: doc.newName("A") })
	const kids = doc.newArray()

	kids.push(widget(doc, page(1), [300, 700, 320, 720], { Parent: choice, AS: doc.newName("A") }))
	kids.push(widget(doc, page(3), [300, 700, 320, 720], { Parent: choice, AS: doc.newName("Off") }))
	choice.put("Kids", kids)
	fields.push(choice)

	const appearance = doc.addStream("0 0 1 RG 3 w 5 5 m 195 35 l S", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 200, 40] })
	const signature = doc.addObject({
		Type: "Sig",
		Filter: "Adobe.PPKLite",
		SubFilter: "ETSI.CAdES.detached",
		ByteRange: [0, 100, 200, 300],
		Contents: doc.newByteString(new Uint8Array(32))
	})

	fields.push(
		widget(doc, page(3), [300, 500, 500, 540], { FT: "Sig", T: doc.newString("approval"), V: signature, AP: { N: appearance } })
	)
	root.put("AcroForm", doc.addObject({ Fields: fields, SigFlags: 3, DA: doc.newString("/Helv 0 Tf 0 g") }))

	// Structure.
	const structRoot = doc.addObject({ Type: "StructTreeRoot" })
	const elements = doc.newArray()
	const nums = doc.newArray()

	pages.forEach((pageObject, index) => {
		const element = doc.addObject({ Type: "StructElem", S: "P", P: structRoot, Pg: pageObject, K: 0 })
		const parents = doc.newArray()

		elements.push(element)
		pageObject.put("StructParents", index)
		parents.push(element)
		nums.push(index)
		nums.push(doc.addObject(parents))
	})
	structRoot.put("K", elements)
	structRoot.put("ParentTree", doc.addObject({ Nums: nums }))
	structRoot.put("ParentTreeNextKey", count)
	root.put("StructTreeRoot", structRoot)
	root.put("MarkInfo", { Marked: true })

	root.put("OpenAction", dest(doc, page(2)))

	const encrypt =
		options.userPassword === undefined
			? ""
			: `,encrypt=aes-256,user-password=${options.userPassword},owner-password=owner-${options.userPassword}`
	const bytes = doc.saveToBuffer(`compress${encrypt}`).asUint8Array().slice()

	doc.destroy()

	return bytes
}

// A second document to insert from: 3 pages "Other N", page 2 with a text field "name" (taken in the organised
// fixture), a link from page 1 to page 3, a link from page 1 to page 2, page-level /AA JavaScript on every page and a
// JavaScript action on the field.
export function makeOtherPdf(): Uint8Array {
	const doc = new mupdf.PDFDocument()
	const font = doc.addSimpleFont(new mupdf.Font("Helvetica"))

	for (let index = 0; index < 3; index++) {
		doc.insertPage(
			-1,
			doc.addPage(
				[0, 0, 612, 792],
				0,
				doc.addObject({ Font: { F1: font } }),
				`BT /F1 24 Tf 72 720 Td (Other ${String(index + 1)}) Tj ET`
			)
		)
	}

	const pages = [doc.findPage(0), doc.findPage(1), doc.findPage(2)]
	const [first, second, third] = pages

	if (first === undefined || second === undefined || third === undefined) throw new Error("no pages")

	for (const page of pages) page.put("AA", { O: { S: "JavaScript", JS: doc.newString("app.alert(3)") } })

	link(doc, first, [72, 600, 200, 620], { Dest: dest(doc, third) })
	link(doc, first, [72, 570, 200, 590], { Dest: dest(doc, second) })

	const field = widget(doc, second, [300, 700, 500, 730], {
		FT: "Tx",
		T: doc.newString("name"),
		V: doc.newString("Bob"),
		AA: { K: { S: "JavaScript", JS: doc.newString("event.rc = true") } }
	})
	const fields = doc.newArray()

	fields.push(field)
	doc.getTrailer()
		.get("Root")
		.put("AcroForm", doc.addObject({ Fields: fields }))

	const bytes = doc.saveToBuffer("compress").asUint8Array().slice()

	doc.destroy()

	return bytes
}

// A page with a white background rectangle and text in its middle, for "Remove white margins": content spans
// x 200-400, y (from the top) 300-500.
export function makeMarginsPdf(): Uint8Array {
	const doc = new mupdf.PDFDocument()
	const content = "1 1 1 rg 0 0 595 842 re f 0 0 0 rg 200 342 200 200 re f\n"

	doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, doc.newDictionary(), content))
	doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, doc.newDictionary(), ""))

	const bytes = doc.saveToBuffer("compress").asUint8Array().slice()

	doc.destroy()

	return bytes
}
