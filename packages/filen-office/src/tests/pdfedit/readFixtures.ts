import * as mupdf from "mupdf"
import { strToU8, zipSync, type Zippable } from "fflate"
import { noise } from "./fixtures"

// E-books for the read role's tests, generated here: an EPUB (navigation, chapters, a Japanese chapter, a right-to-left
// one, optionally an image or an encryption.xml), an FB2 and a minimal PalmDOC MOBI.

const XHTML = (body: string, lang?: string): string =>
	`<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"${
		lang === undefined ? "" : ` xml:lang="${lang}" lang="${lang}"`
	}><head><title>c</title></head><body>${body}</body></html>`

export const LOREM = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore. "

export interface EpubOptions {
	// An image of this many pixels a side (incompressible) alone on a chapter; JPEG in CMYK, the heaviest decode.
	readonly imageSide?: number
	// META-INF/encryption.xml naming these algorithms for a chapter.
	readonly encryption?: readonly string[]
}

export const EPUB_CHAPTERS = ["Opening", "Japanese", "Hebrew"] as const

export function makeEpub(options: EpubOptions = {}): Uint8Array {
	const image = options.imageSide === undefined ? null : cmykJpeg(options.imageSide)
	const files: Zippable = {
		mimetype: [strToU8("application/epub+zip"), { level: 0 }],
		"META-INF/container.xml": strToU8(
			'<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
		),
		"OEBPS/content.opf": strToU8(
			`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">read-fixture</dc:identifier><dc:title>Test Book</dc:title><dc:creator>An Author</dc:creator><dc:subject>Testing</dc:subject><dc:language>en</dc:language></metadata><manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/><item id="c3" href="c3.xhtml" media-type="application/xhtml+xml"/>${
				image === null
					? ""
					: '<item id="c4" href="c4.xhtml" media-type="application/xhtml+xml"/><item id="img" href="image.jpg" media-type="image/jpeg"/>'
			}</manifest><spine toc="ncx"><itemref idref="c1"/><itemref idref="c2"/><itemref idref="c3"/>${
				image === null ? "" : '<itemref idref="c4"/>'
			}</spine></package>`
		),
		"OEBPS/toc.ncx": strToU8(
			`<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head/><docTitle><text>Test Book</text></docTitle><navMap>${EPUB_CHAPTERS.map(
				(title, index) =>
					`<navPoint id="n${String(index + 1)}" playOrder="${String(index + 1)}"><navLabel><text>${title}</text></navLabel><content src="c${String(index + 1)}.xhtml"/></navPoint>`
			).join("")}</navMap></ncx>`
		),
		"OEBPS/c1.xhtml": strToU8(XHTML(`<h1>Opening</h1>${`<p>${LOREM.repeat(4)}</p>`.repeat(40)}<p>The unique anchor phrase.</p>`)),
		"OEBPS/c2.xhtml": strToU8(XHTML("<h1>Japanese</h1><p>日本語のテキスト。漢字とかなを含む。</p>", "ja")),
		"OEBPS/c3.xhtml": strToU8(
			XHTML('<h1>Hebrew</h1><p dir="rtl">שלום עולם וכל יושביו</p><p><a href="c1.xhtml">Back to the opening</a></p>')
		)
	}

	if (image !== null) {
		files["OEBPS/c4.xhtml"] = strToU8(XHTML('<div><img src="image.jpg" alt=""/></div>'))
		files["OEBPS/image.jpg"] = [image, { level: 0 }]
	}

	if (options.encryption !== undefined) {
		files["META-INF/encryption.xml"] = strToU8(
			`<?xml version="1.0"?><encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">${options.encryption
				.map(
					algorithm =>
						`<enc:EncryptedData><enc:EncryptionMethod Algorithm="${algorithm}"/><enc:CipherData><enc:CipherReference URI="OEBPS/c2.xhtml"/></enc:CipherData></enc:EncryptedData>`
				)
				.join("")}</encryption>`
		)
	}

	return zipSync(files)
}

// An incompressible CMYK JPEG of side x side pixels.
export function cmykJpeg(side: number): Uint8Array {
	const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceCMYK, [0, 0, side, side], false)

	try {
		pixmap.getPixels().set(noise(side * side * 4, side))

		return pixmap.asJPEG(95)
	} finally {
		pixmap.destroy()
	}
}

export function makeFb2(): Uint8Array {
	return strToU8(
		`<?xml version="1.0" encoding="utf-8"?><FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"><description><title-info><book-title>FB Title</book-title><author><first-name>Ann</first-name><last-name>Writer</last-name></author><lang>en</lang></title-info></description><body><section><title><p>Chapter A</p></title>${`<p>${LOREM.repeat(4)}</p>`.repeat(30)}</section><section><title><p>Chapter B</p></title><p>The second chapter.</p></section></body></FictionBook>`
	)
}

// A PalmDB with one uncompressed PalmDOC text record per 4 KiB; `encryption` is the PalmDOC header's encryption field.
export function makeMobi(encryption = 0): Uint8Array {
	const text = strToU8(`<html><body><h1>Mobi</h1>${`<p>${LOREM.repeat(4)}</p>`.repeat(20)}</body></html>`)
	const recordSize = 4096
	const records: Uint8Array[] = []
	const header = new Uint8Array(16 + 232)
	const view = new DataView(header.buffer)
	const textRecords = Math.ceil(text.length / recordSize)

	view.setUint16(0, 1)
	view.setUint32(4, text.length)
	view.setUint16(8, textRecords)
	view.setUint16(10, recordSize)
	view.setUint16(12, encryption)
	header.set(strToU8("MOBI"), 16)
	view.setUint32(20, 232)
	view.setUint32(24, 2)
	view.setUint32(28, 65001)
	view.setUint32(16 + 0x50, 0xffffffff)
	records.push(header)

	for (let at = 0; at < text.length; at += recordSize) records.push(text.subarray(at, at + recordSize))

	const list = 78 + records.length * 8 + 2
	const out = new Uint8Array(list + records.reduce((sum, record) => sum + record.length, 0))
	const outView = new DataView(out.buffer)
	let at = list

	out.set(strToU8("Test Mobi"), 0)
	out.set(strToU8("BOOKMOBI"), 60)
	outView.setUint16(76, records.length)
	records.forEach((record, index) => {
		outView.setUint32(78 + index * 8, at)
		outView.setUint32(78 + index * 8 + 4, index)
		out.set(record, at)
		at += record.length
	})

	return out
}
