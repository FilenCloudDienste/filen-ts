import { mkdirSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import * as mupdf from "mupdf"

// Generates the form fixtures in src/tests/fixtures/pdfforms/. Every object is written here by hand with MuPDF's
// object API (no third-party PDF), so each file holds exactly the structures the form tests name:
//
//   acroform.pdf     every AcroForm widget type over two pages: text (single line, multi-line, comb, max length,
//                    password flag on a field named "password", read-only, required), checkbox, a radio group with
//                    one button per page, combo, editable combo, list, multi-select list, push button, signature
//   calculated.pdf   fields with JavaScript calculate (/AA /C, AcroForm /CO), format (/F) and validate (/V) actions
//   hybrid-xfa.pdf   an AcroForm with fields and an /XFA packet (filled through the AcroForm)
//   xfa-only.pdf     an /XFA packet with no AcroForm fields (/NeedsRendering)
//
//   pnpm exec tsx src/scripts/pdfFormFixtures.ts

const OUT = fileURLToPath(new URL("../tests/fixtures/pdfforms/", import.meta.url))

type Rect = readonly [number, number, number, number]

interface Built {
	readonly document: mupdf.PDFDocument
	readonly font: mupdf.PDFObject
	readonly pages: mupdf.PDFObject[]
	readonly fields: mupdf.PDFObject
}

// Field flags (PDF 32000-1 §12.7.3, §12.7.4).
const FF = {
	readOnly: 1,
	required: 1 << 1,
	multiline: 1 << 12,
	password: 1 << 13,
	noToggleToOff: 1 << 14,
	radio: 1 << 15,
	pushButton: 1 << 16,
	combo: 1 << 17,
	edit: 1 << 18,
	multiSelect: 1 << 21,
	comb: 1 << 24
} as const

const PRINT = 4

function start(pageCount: number): Built {
	const document = new mupdf.PDFDocument()
	const font = document.addSimpleFont(new mupdf.Font("Helvetica"))
	const pages: mupdf.PDFObject[] = []

	for (let index = 0; index < pageCount; index++) {
		const resources = document.addObject({ Font: { Helv: font } })
		const content = `BT /Helv 18 Tf 72 790 Td (Form page ${String(index + 1)}) Tj ET\n`

		document.insertPage(-1, document.addPage([0, 0, 595, 842], 0, resources, content))
		pages.push(document.findPage(index))
	}

	const fields = document.newArray()
	const acroForm = document.addObject({ DA: "(/Helv 0 Tf 0 g)", NeedAppearances: false })

	acroForm.put("Fields", fields)
	acroForm.put("DR", document.newDictionary())
	acroForm.get("DR").put("Font", document.newDictionary())
	acroForm.get("DR").get("Font").put("Helv", font)
	document.getTrailer().get("Root").put("AcroForm", acroForm)

	return { document, font, pages, fields }
}

function addAnnot(built: Built, page: number, widget: mupdf.PDFObject): void {
	const pageObject = built.pages[page]

	if (pageObject === undefined) throw new Error(`no page ${String(page)}`)

	let annots = pageObject.get("Annots")

	if (annots.isNull()) {
		annots = built.document.newArray()
		pageObject.put("Annots", annots)
	}

	widget.put("P", pageObject)
	annots.push(widget)
}

// A terminal field that is its own widget.
function field(built: Built, page: number, rect: Rect, entries: Record<string, unknown>): mupdf.PDFObject {
	const object = built.document.addObject({ Type: "Annot", Subtype: "Widget", F: PRINT, DA: "(/Helv 11 Tf 0 g)", ...entries })

	object.put("Rect", [...rect])
	object.put("MK", { BC: [0.4, 0.4, 0.4], BG: [1, 1, 1] })
	addAnnot(built, page, object)
	built.fields.push(object)

	return object
}

function stream(built: Built, rect: Rect, content: string): mupdf.PDFObject {
	const width = rect[2] - rect[0]
	const height = rect[3] - rect[1]

	return built.document.addStream(content, {
		Type: "XObject",
		Subtype: "Form",
		BBox: [0, 0, width, height],
		Resources: {}
	})
}

// On/off appearances for a check box or radio button: a filled square when on, an empty frame when off.
function buttonAppearance(built: Built, rect: Rect, on: string): mupdf.PDFObject {
	const width = rect[2] - rect[0]
	const height = rect[3] - rect[1]
	const frame = `0.4 G 1 w 0.5 0.5 ${String(width - 1)} ${String(height - 1)} re S\n`
	const normal = built.document.newDictionary()

	normal.put(on, stream(built, rect, `${frame}0 g 3 3 ${String(width - 6)} ${String(height - 6)} re f\n`))
	normal.put("Off", stream(built, rect, frame))

	const appearance = built.document.newDictionary()

	appearance.put("N", normal)

	return appearance
}

function save(built: Built, name: string): void {
	const bytes = built.document.saveToBuffer("compress").asUint8Array().slice()

	built.document.destroy()
	writeFileSync(`${OUT}${name}`, bytes)
}

function acroform(): void {
	const built = start(2)

	field(built, 0, [72, 740, 300, 760], { FT: "Tx", T: "(name)", TU: "(Full name)" })
	field(built, 0, [72, 660, 300, 730], { FT: "Tx", T: "(notes)", TU: "(Notes)", Ff: FF.multiline })
	field(built, 0, [72, 630, 192, 650], { FT: "Tx", T: "(code)", TU: "(Code)", Ff: FF.comb, MaxLen: 6 })
	field(built, 0, [72, 600, 192, 620], { FT: "Tx", T: "(zip)", TU: "(Postal code)", MaxLen: 5 })
	field(built, 0, [72, 570, 300, 590], { FT: "Tx", T: "(password)", TU: "(Password)", Ff: FF.password })
	field(built, 0, [72, 540, 300, 560], { FT: "Tx", T: "(readonly)", TU: "(Read-only)", Ff: FF.readOnly, V: "(fixed)" })
	field(built, 0, [72, 510, 300, 530], { FT: "Tx", T: "(required)", TU: "(Required)", Ff: FF.required })

	const agreeRect: Rect = [72, 480, 88, 496]
	const agree = field(built, 0, agreeRect, { FT: "Btn", T: "(agree)", TU: "(I agree)", V: "Off", AS: "Off" })

	agree.put("AP", buttonAppearance(built, agreeRect, "Yes"))

	// One radio group, one button on each page (kids of one parent field).
	const radio = built.document.addObject({ FT: "Btn", T: "(choice)", TU: "(Choice)", Ff: FF.radio | FF.noToggleToOff, V: "Off" })
	const kids = built.document.newArray()
	const radioA: Rect = [72, 450, 88, 466]
	const radioB: Rect = [72, 740, 88, 756]
	const kidA = built.document.addObject({ Type: "Annot", Subtype: "Widget", F: PRINT, AS: "Off" })
	const kidB = built.document.addObject({ Type: "Annot", Subtype: "Widget", F: PRINT, AS: "Off" })

	kidA.put("Rect", [...radioA])
	kidB.put("Rect", [...radioB])
	kidA.put("AP", buttonAppearance(built, radioA, "A"))
	kidB.put("AP", buttonAppearance(built, radioB, "B"))
	kidA.put("Parent", radio)
	kidB.put("Parent", radio)
	kids.push(kidA)
	kids.push(kidB)
	radio.put("Kids", kids)
	addAnnot(built, 0, kidA)
	addAnnot(built, 1, kidB)
	built.fields.push(radio)

	field(built, 0, [72, 410, 240, 430], {
		FT: "Ch",
		T: "(country)",
		TU: "(Country)",
		Ff: FF.combo,
		Opt: ["(Germany)", "(France)", "(Italy)"]
	})
	field(built, 0, [72, 380, 240, 400], {
		FT: "Ch",
		T: "(city)",
		TU: "(City)",
		Ff: FF.combo | FF.edit,
		Opt: ["(Berlin)", "(Paris)", "(Rome)"]
	})
	field(built, 0, [72, 310, 240, 370], { FT: "Ch", T: "(colour)", TU: "(Colour)", Opt: ["(Red)", "(Green)", "(Blue)"] })
	field(built, 0, [260, 310, 428, 370], {
		FT: "Ch",
		T: "(toppings)",
		TU: "(Toppings)",
		Ff: FF.multiSelect,
		Opt: ["(Cheese)", "(Ham)", "(Olives)", "(Pepper)"]
	})
	field(built, 0, [72, 270, 160, 294], { FT: "Btn", T: "(reset)", TU: "(Reset)", Ff: FF.pushButton })
	field(built, 0, [72, 200, 272, 250], { FT: "Sig", T: "(signature)", TU: "(Signature)" })
	field(built, 1, [120, 740, 400, 760], { FT: "Tx", T: "(page2)", TU: "(Second page)" })

	// Appearances for every field as a viewer would have made them.
	for (let index = 0; index < 2; index++) {
		const page = built.document.loadPage(index)

		for (const widget of page.getWidgets()) widget.update()
	}

	save(built, "acroform.pdf")
}

function javaScript(built: Built, code: string): mupdf.PDFObject {
	return built.document.addObject({ S: "JavaScript", JS: `(${code})` })
}

function calculated(): void {
	const built = start(1)

	field(built, 0, [72, 740, 200, 760], { FT: "Tx", T: "(a)", TU: "(First number)" })
	field(built, 0, [72, 700, 200, 720], { FT: "Tx", T: "(b)", TU: "(Second number)" })

	const total = field(built, 0, [72, 660, 200, 680], { FT: "Tx", T: "(total)", TU: "(Total)", Ff: FF.readOnly })
	const actions = built.document.newDictionary()

	actions.put("C", javaScript(built, 'event.value = Number(this.getField("a").value) + Number(this.getField("b").value);'))
	actions.put("F", javaScript(built, 'AFNumber_Format(2, 0, 0, 0, "", true);'))
	actions.put("V", javaScript(built, "event.rc = event.value >= 0;"))
	total.put("AA", actions)

	const order = built.document.newArray()

	order.push(total)
	built.document.getTrailer().get("Root").get("AcroForm").put("CO", order)

	for (const widget of built.document.loadPage(0).getWidgets()) widget.update()

	save(built, "calculated.pdf")
}

const XDP = `<?xml version="1.0" encoding="UTF-8"?>
<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/">
<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form1"><field name="name"/></subform></template>
<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form1><name>XFA value</name></form1></xfa:data></xfa:datasets>
</xdp:xdp>
`

function hybridXfa(): void {
	const built = start(1)

	field(built, 0, [72, 740, 300, 760], { FT: "Tx", T: "(name)", TU: "(Full name)" })
	built.document.getTrailer().get("Root").get("AcroForm").put("XFA", built.document.addStream(XDP, {}))

	for (const widget of built.document.loadPage(0).getWidgets()) widget.update()

	save(built, "hybrid-xfa.pdf")
}

function xfaOnly(): void {
	const built = start(1)
	const root = built.document.getTrailer().get("Root")

	root.get("AcroForm").put("XFA", built.document.addStream(XDP, {}))
	root.put("NeedsRendering", true)
	save(built, "xfa-only.pdf")
}

mkdirSync(OUT, { recursive: true })
acroform()
calculated()
hybridXfa()
xfaOnly()
