import * as mupdf from "mupdf"

// Small PDFs made with MuPDF itself for the engine tests.

export interface MakePdfOptions {
	readonly pages: number
	// Bytes of incompressible image data per page (0: text only).
	readonly imageBytes?: number
	// Saves with AES-256 under these passwords.
	readonly userPassword?: string
	readonly ownerPassword?: string
}

function noise(length: number, seed: number): Uint8Array {
	const bytes = new Uint8Array(length)
	let state = seed >>> 0 || 1

	for (let index = 0; index < length; index++) {
		// xorshift32: no structure deflate could exploit.
		state ^= state << 13
		state ^= state >>> 17
		state ^= state << 5
		bytes[index] = state & 0xff
	}

	return bytes
}

export function makePdf(options: MakePdfOptions): Uint8Array {
	const document = new mupdf.PDFDocument()
	const font = document.addSimpleFont(new mupdf.Font("Helvetica"))

	for (let index = 0; index < options.pages; index++) {
		const resources: Record<string, unknown> = { Font: { F1: font } }
		let content = `0 0 1 rg 50 50 200 100 re f BT /F1 24 Tf 72 720 Td (Page ${String(index + 1)}) Tj ET\n`

		if ((options.imageBytes ?? 0) > 0) {
			const side = Math.max(1, Math.floor(Math.sqrt((options.imageBytes ?? 0) / 3)))
			const image = document.addRawStream(noise(side * side * 3, index + 1), {
				Type: "XObject",
				Subtype: "Image",
				Width: side,
				Height: side,
				ColorSpace: "DeviceRGB",
				BitsPerComponent: 8
			})

			resources["XObject"] = { Im1: image }
			content += "q 300 0 0 300 150 300 cm /Im1 Do Q\n"
		}

		document.insertPage(-1, document.addPage([0, 0, 595, 842], 0, document.addObject(resources), content))
	}

	const encrypt =
		options.userPassword === undefined
			? ""
			: `,encrypt=aes-256,user-password=${options.userPassword},owner-password=${options.ownerPassword ?? options.userPassword}`
	const saved = document.saveToBuffer(`compress${encrypt}`).asUint8Array().slice()

	document.destroy()

	return saved
}

// What a wasm trap throws (WebAssembly.RuntimeError), without the WebAssembly typings.
export function wasmTrap(): Error {
	const error = new Error("unreachable")

	error.name = "RuntimeError"

	return error
}

function appearance(document: mupdf.PDFDocument, on: string): mupdf.PDFObject {
	const box = { BBox: [0, 0, 14, 14] }

	return document.addObject({
		N: { [on]: document.addStream("0 0 1 rg 2 2 10 10 re f", box), Off: document.addStream("", box) }
	})
}

// Two pages with a form: a text field ("name", at most 20 characters), a checkbox ("agree"), a read-only text field
// ("fixed"), a combo box ("colour") and a radio group ("choice") with a button on each page; a web link and a link to
// page 2 on page 1. `orphan`: an unused object written before the form's own (a free number a compacting rewrite
// would close by renumbering every object after it).
export function makeFormPdf(options: { readonly orphan?: boolean } = {}): Uint8Array {
	const document = new mupdf.PDFDocument()

	if (options.orphan === true) document.addObject({ Unused: true })

	const font = document.addSimpleFont(new mupdf.Font("Helvetica"))
	const resources = document.addObject({ Font: { Helv: font } })

	for (let index = 0; index < 2; index++) {
		const content = `BT /Helv 18 Tf 72 760 Td (Form page ${String(index + 1)}) Tj ET\n`

		document.insertPage(-1, document.addPage([0, 0, 595, 842], 0, resources, content))
	}

	const first = document.findPage(0)
	const second = document.findPage(1)
	// A JavaScript string becomes a name object in MuPDF's object builder; text values must be strings.
	const string = (value: string) => document.newString(value)
	const widget = (fields: Record<string, unknown>) => document.addObject({ Type: "Annot", Subtype: "Widget", F: 4, ...fields })
	const name = widget({ FT: "Tx", T: string("name"), Rect: [72, 680, 300, 700], P: first, DA: string("/Helv 12 Tf 0 g"), MaxLen: 20 })
	const fixed = widget({
		FT: "Tx",
		T: string("fixed"),
		Rect: [72, 600, 300, 620],
		P: first,
		DA: string("/Helv 12 Tf 0 g"),
		Ff: 1,
		V: string("Locked")
	})
	const agree = widget({
		FT: "Btn",
		T: string("agree"),
		Rect: [72, 640, 86, 654],
		P: first,
		V: document.newName("Off"),
		AS: document.newName("Off"),
		AP: appearance(document, "Yes")
	})
	const colour = widget({
		FT: "Ch",
		Ff: 1 << 17,
		T: string("colour"),
		Rect: [72, 560, 200, 580],
		P: first,
		DA: string("/Helv 12 Tf 0 g"),
		Opt: [string("Red"), string("Green"), string("Blue")],
		V: string("Red")
	})
	const choice = document.addObject({ FT: "Btn", Ff: 1 << 15, T: string("choice"), V: document.newName("Off") })
	const radio = (page: mupdf.PDFObject, on: string) =>
		widget({ Parent: choice, Rect: [72, 520, 86, 534], P: page, AS: document.newName("Off"), AP: appearance(document, on) })
	const radioA = radio(first, "A")
	const radioB = radio(second, "B")

	choice.put("Kids", [radioA, radioB])

	const web = document.addObject({
		Type: "Annot",
		Subtype: "Link",
		Rect: [72, 450, 200, 470],
		A: { S: "URI", URI: string("https://filen.io/") }
	})
	const toSecond = document.addObject({
		Type: "Annot",
		Subtype: "Link",
		Rect: [72, 420, 200, 440],
		Dest: [second, document.newName("XYZ"), 0, 800, 0]
	})

	first.put("Annots", [name, agree, fixed, colour, radioA, web, toSecond])
	second.put("Annots", [radioB])
	document
		.getTrailer()
		.get("Root")
		.put(
			"AcroForm",
			document.addObject({ Fields: [name, agree, fixed, colour, choice], DA: string("/Helv 0 Tf 0 g"), DR: { Font: { Helv: font } } })
		)

	const saved = document.saveToBuffer("compress").asUint8Array().slice()

	document.destroy()

	return saved
}
