import { sniffImage } from "../docx/objects/images"
import { dibToBmp, hasPlaceableHeader, withPlaceableHeader } from "../metafile/bitmap"

// \pict pictures (Microsoft RTF Specification 1.9.1, "Pictures"): the blip type, the size and crop words,
// and the data as hexadecimal text or \binN bytes. PNG, JPEG and EMF are kept as they are; a Windows
// metafile gets the placeable header RTF leaves out (the size comes from the words around it); a
// device-independent bitmap gets the BITMAPFILEHEADER that makes it a .bmp. Other sources (device-dependent
// bitmaps, QuickDraw, OS/2 metafiles) are reported as unsupported and stay in the source bytes only.

export type PictureSource = "png" | "jpeg" | "emf" | "wmf" | "dib" | "ddb" | "macpict" | "pmmetafile" | "unknown"

// Data larger than this is not decoded (the source keeps it).
export const MAX_PICTURE_BYTES = 64 * 1024 * 1024

export class PictureBuilder {
	source: PictureSource = "unknown"
	mapMode = 1
	picw = 0
	pich = 0
	goalW = 0
	goalH = 0
	scaleX = 100
	scaleY = 100
	cropT = 0
	cropB = 0
	cropL = 0
	cropR = 0
	// Alternative text (\\picprop's wzDescription) and title (wzName is the shape's name, not shown).
	description = ""
	private data = new Uint8Array(0)
	private length = 0
	private pending = -1
	tooLarge = false

	// Hexadecimal digits in [start, end); anything that is not a digit (spaces, line breaks) is skipped.
	hex(bytes: Uint8Array, start: number, end: number): void {
		if (this.tooLarge) return

		this.reserve(this.length + ((end - start + 1) >> 1))

		if (this.tooLarge) return

		const data = this.data
		let length = this.length
		let pending = this.pending

		for (let i = start; i < end; i++) {
			const byte = bytes[i] ?? 0
			let value: number

			if (byte >= 0x30 && byte <= 0x39) value = byte - 0x30
			else if (byte >= 0x61 && byte <= 0x66) value = byte - 0x57
			else if (byte >= 0x41 && byte <= 0x46) value = byte - 0x37
			else continue

			if (pending < 0) pending = value
			else {
				data[length++] = (pending << 4) | value
				pending = -1
			}
		}

		this.length = length
		this.pending = pending
	}

	binary(bytes: Uint8Array, start: number, end: number): void {
		if (this.tooLarge) return

		this.reserve(this.length + (end - start))

		if (this.tooLarge) return

		this.data.set(bytes.subarray(start, end), this.length)
		this.length += end - start
	}

	private reserve(size: number): void {
		if (size > MAX_PICTURE_BYTES) {
			this.tooLarge = true

			return
		}

		if (size <= this.data.length) return

		const grown = new Uint8Array(Math.max(size, Math.min(MAX_PICTURE_BYTES, this.data.length * 2)))

		grown.set(this.data.subarray(0, this.length))
		this.data = grown
	}

	// The picture as a media part, or why it has none.
	finish(): Picture | { readonly unsupported: PictureSource | "empty" | "tooLarge" | "corrupt" } {
		if (this.tooLarge) return { unsupported: "tooLarge" }
		if (this.length === 0) return { unsupported: "empty" }

		let bytes: Uint8Array = this.data.subarray(0, this.length)

		switch (this.source) {
			case "png":
			case "jpeg":
			case "emf":
				break
			case "wmf":
				bytes = placeableWmf(bytes, this.goalW || twipsOfHimetric(this.picw), this.goalH || twipsOfHimetric(this.pich))
				break
			case "dib":
				bytes = dibToBmp(bytes)
				break
			default:
				// Writers mislabel blips: what the bytes are decides.
				break
		}

		const info = sniffImage(bytes)

		if (typeof info === "string") return { unsupported: this.source === "unknown" || this.source === "png" ? "corrupt" : this.source }

		const raster = info.format !== "emf" && info.format !== "wmf" && info.format !== "svg"
		// Twips: the goal size when given, else the pixel size at 96 dpi (rasters) or the metafile's own.
		const naturalW = raster
			? this.picw > 0
				? this.picw * 15
				: info.width * 15
			: this.picw > 0
				? twipsOfHimetric(this.picw)
				: info.width * 15
		const naturalH = raster
			? this.pich > 0
				? this.pich * 15
				: info.height * 15
			: this.pich > 0
				? twipsOfHimetric(this.pich)
				: info.height * 15
		const fullW = this.goalW > 0 ? this.goalW : naturalW
		const fullH = this.goalH > 0 ? this.goalH : naturalH
		const shownW = Math.max(1, ((fullW - this.cropL - this.cropR) * Math.max(1, this.scaleX)) / 100)
		const shownH = Math.max(1, ((fullH - this.cropT - this.cropB) * Math.max(1, this.scaleY)) / 100)

		return {
			bytes,
			contentType: info.contentType,
			extension: info.extension,
			// EMUs: 635 per twip.
			description: this.description,
			cx: Math.round(shownW * 635),
			cy: Math.round(shownH * 635),
			crop:
				(this.cropL === 0 && this.cropR === 0 && this.cropT === 0 && this.cropB === 0) || fullW <= 0 || fullH <= 0
					? undefined
					: {
							left: Math.round((this.cropL / fullW) * 100000),
							right: Math.round((this.cropR / fullW) * 100000),
							top: Math.round((this.cropT / fullH) * 100000),
							bottom: Math.round((this.cropB / fullH) * 100000)
						}
		}
	}
}

export interface Picture {
	readonly bytes: Uint8Array
	readonly contentType: string
	readonly extension: string
	readonly cx: number
	readonly cy: number
	// a:srcRect, in thousandths of a percent.
	readonly crop: { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number } | undefined
	// wp:docPr/@descr.
	readonly description: string
}

function twipsOfHimetric(value: number): number {
	return Math.round((value * 1440) / 2540)
}

// The first window origin and extent a metafile's records set: the logical frame of its picture.
function metafileWindow(bytes: Uint8Array): { x: number; y: number; w: number; h: number } | undefined {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

	if (bytes.length < 18) return undefined

	let at = view.getUint16(2, true) * 2
	let x = 0
	let y = 0

	for (let count = 0; at + 6 <= bytes.length && count < 100_000; count++) {
		const size = view.getUint32(at, true)
		const fn = view.getUint16(at + 4, true)

		if (size < 3 || fn === 0) break

		if (fn === 0x20b && at + 10 <= bytes.length) {
			y = view.getInt16(at + 6, true)
			x = view.getInt16(at + 8, true)
		} else if (fn === 0x20c && at + 10 <= bytes.length) {
			return { x, y, w: view.getInt16(at + 8, true), h: view.getInt16(at + 6, true) }
		}

		at += size * 2
	}

	return undefined
}

// A Windows metafile as RTF stores it (no placeable header) with the header [MS-WMF] §2.3.2.3 puts before
// it: the frame is the records' window, its units per inch whatever makes it `twipsW` wide.
function placeableWmf(bytes: Uint8Array, twipsW: number, twipsH: number): Uint8Array {
	if (hasPlaceableHeader(bytes)) return bytes

	const window = metafileWindow(bytes)
	const w = window?.w ?? (twipsW > 0 ? twipsW : 1440)
	const h = window?.h ?? (twipsH > 0 ? twipsH : 1440)
	const x = window?.x ?? 0
	const y = window?.y ?? 0
	const inch = twipsW > 0 ? Math.round((Math.abs(w) * 1440) / twipsW) : twipsH > 0 ? Math.round((Math.abs(h) * 1440) / twipsH) : 1440

	return withPlaceableHeader(bytes, {
		left: x,
		top: y,
		right: clamp16(x + w),
		bottom: clamp16(y + h),
		inch: Math.max(1, Math.min(0xffff, inch))
	})
}

function clamp16(value: number): number {
	return Math.max(-32768, Math.min(32767, value))
}
