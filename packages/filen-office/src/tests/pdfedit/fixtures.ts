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
