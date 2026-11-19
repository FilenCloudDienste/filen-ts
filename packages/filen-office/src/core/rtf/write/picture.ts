import { maxOf } from "../../arrays"
import { sniffImage } from "../../docx/objects/images"
import { RtfOut, RtfWriteRefusal, latin1Bytes } from "./out"
import { encodeText } from "./encode"

// A picture the edit inserted, as Word writes one (RTF 1.9.1, "Pictures"): {\*\shppict{\pict ...\pngblip|\jpegblip
// ...}} for readers of Word 97 and later, then {\nonshppict{\pict\wmetafile8 ...}} for older ones: a Windows metafile
// whose one META_STRETCHDIB record holds the same bytes as a device-independent bitmap compressed as PNG or JPEG
// ([MS-WMF] 2.3.1.3.4 META_STRETCHDIB, 2.2.2.9 DeviceIndependentBitmap, 2.1.1.7 Compression BI_PNG / BI_JPEG).

// Each byte's two lower-case hex digits, as ASCII: high << 8 | low.
const HEX_PAIRS = (() => {
	const digits = "0123456789abcdef"
	const pairs = new Uint16Array(256)

	for (let byte = 0; byte < 256; byte++) pairs[byte] = (digits.charCodeAt(byte >> 4) << 8) | digits.charCodeAt(byte & 15)

	return pairs
})()

// The bytes in hex, CR LF and 64 bytes a line, as Word writes them (line breaks are not text): written straight into
// the bytes they end as.
function hex(bytes: Uint8Array, out: RtfOut): void {
	if (bytes.length === 0) return

	const text = new Uint8Array(bytes.length * 2 + Math.ceil(bytes.length / 64) * 2)
	let at = 0

	for (let k = 0; k < bytes.length; k++) {
		if (k % 64 === 0) {
			text[at++] = 0x0d
			text[at++] = 0x0a
		}

		const pair = HEX_PAIRS[bytes[k] ?? 0] ?? 0

		text[at++] = pair >> 8
		text[at++] = pair & 0xff
	}

	out.bytes(text)
}

// The metafile: header, window origin and extent, the bitmap stretched over it, end.
function stretchDibMetafile(image: Uint8Array, format: "png" | "jpeg", width: number, height: number): Uint8Array {
	const header = 40
	const dibBytes = header + image.length + (image.length % 2)
	// Words: size (2), function (1), raster operation (2), colour usage (1), 8 coordinates, the DIB.
	const stretch = 3 + 2 + 1 + 8 + dibBytes / 2
	const records = [5, 5, stretch, 3]
	const total = 9 + records.reduce((sum, words) => sum + words, 0)
	const out = new Uint8Array(total * 2)
	const view = new DataView(out.buffer)
	let at = 0
	const u16 = (value: number): void => {
		view.setUint16(at, value & 0xffff, true)
		at += 2
	}
	const u32 = (value: number): void => {
		view.setUint32(at, value >>> 0, true)
		at += 4
	}

	// META_HEADER: memory metafile, 9 words, version 3.0, size in words, no objects, the largest record, 0.
	u16(1)
	u16(9)
	u16(0x0300)
	u32(total)
	u16(0)
	u32(maxOf(records))
	u16(0)
	// META_SETWINDOWORG (y, x) and META_SETWINDOWEXT (height, width).
	u32(5)
	u16(0x020b)
	u16(0)
	u16(0)
	u32(5)
	u16(0x020c)
	u16(height)
	u16(width)
	// META_STRETCHDIB: SRCCOPY, DIB_RGB_COLORS, source and destination rectangles, then the DIB.
	u32(stretch)
	u16(0x0f43)
	u32(0x00cc0020)
	u16(0)
	u16(height)
	u16(width)
	u16(0)
	u16(0)
	u16(height)
	u16(width)
	u16(0)
	u16(0)
	// BITMAPINFOHEADER: 40 bytes, the size, one plane, bit count 0 and the compression for PNG or JPEG data.
	u32(header)
	u32(width)
	u32(height)
	u16(1)
	u16(0)
	u32(format === "png" ? 5 : 4)
	u32(image.length)
	u32(3780)
	u32(3780)
	u32(0)
	u32(0)
	out.set(image, at)
	at += image.length + (image.length % 2)
	// META_EOF.
	u32(3)
	u16(0)

	return out
}

export interface NewPicture {
	readonly bytes: Uint8Array
	// The size shown, in EMUs.
	readonly cx: number
	readonly cy: number
	readonly description: string
}

export function writeNewPicture(picture: NewPicture, codepage: number, out: RtfOut): void {
	const info = sniffImage(picture.bytes)

	if (typeof info === "string" || (info.format !== "png" && info.format !== "jpeg"))
		throw new RtfWriteRefusal("picture", "a picture neither PNG nor JPEG (RTF 1.9.1's blips besides metafiles)")

	// \picwgoal / \pichgoal are twips, 635 EMUs each: a size between two twips has no form.
	if (picture.cx % 635 !== 0 || picture.cy % 635 !== 0) throw new RtfWriteRefusal("picture", "a size between twips")

	const goalW = picture.cx / 635
	const goalH = picture.cy / 635
	const blip = info.format === "png" ? "pngblip" : "jpegblip"

	out.rtf("{\\*").word("shppict").rtf("{").word("pict")

	if (picture.description !== "") {
		const encoded = encodeText(picture.description, codepage)

		out.rtf("{\\*").word("picprop").rtf("{").word("sp").rtf("{").word("sn").rtf("wzDescription}{").word("sv")
		if (encoded.unicode) out.word("uc", 1)
		out.bytes(latin1Bytes(encoded.rtf)).rtf("}}}")
	}

	out.word(blip).word("picw", info.width).word("pich", info.height).word("picwgoal", goalW).word("pichgoal", goalH)
	hex(picture.bytes, out)
	out.rtf("}}{").word("nonshppict").rtf("{").word("pict").word("wmetafile", 8)
	// Metafile extents in himetric.
	out.word("picw", Math.round((goalW * 2540) / 1440)).word("pich", Math.round((goalH * 2540) / 1440))
	out.word("picwgoal", goalW).word("pichgoal", goalH)
	hex(stretchDibMetafile(picture.bytes, info.format, info.width, info.height), out)
	out.rtf("}}")
}
