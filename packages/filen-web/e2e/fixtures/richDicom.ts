import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
	DEFLATED,
	EXPLICIT_LE,
	JPEG_2000,
	JPEG_BASELINE,
	JPEG_LS,
	RLE,
	dicomFile,
	encapsulated,
	frameOffsets,
	grayModule,
	rleFrame,
	text,
	us,
	type DicomElement
} from "@/tests/support/dicomBytes"

// The DICOM viewer's files, written here (src/tests/support/dicomBytes.ts) around pixel data built here, except the
// three codestreams in ./dicom/, which need their encoders and are committed. They were written in Node by the codecs'
// own builds: rich-jls.jls by @cornerstonejs/codec-charls 1.2.7 (wasmjs, JpegLSEncoder) and rich-j2k.j2k by
// @cornerstonejs/codec-openjpeg 1.3.6 (wasmjs, J2KEncoder, setDecompositions(3)), each from a 96×96 12-bit ring
// pattern, round((sin(hypot(x − 48, y − 48) / 4) + 1) × 2047); rich-color.jpg by @jsquash/jpeg 1.6.0 (MozJPEG; baseline,
// not progressive, quality 90) from a 96×96 gradient, RGBA (x × 2.6, y × 2.6, 255 − x × 2.6, 255).

const CODESTREAMS = fileURLToPath(new URL("./dicom/", import.meta.url))

export const RICH_DICOM_PATIENT = "Rich^Fixture"
export const RICH_CINE_FRAMES = 8

const SIDE = 128

function patient(modality: string): DicomElement[] {
	return [text(0x00080060, "CS", modality), text(0x00100010, "PN", RICH_DICOM_PATIENT)]
}

// A 128×128 CT frame stored 12 bits in 16, signed, rescaled to Hounsfield units: a disc of soft tissue in air.
function ctPixels(): Uint8Array {
	const pixels = new Uint8Array(SIDE * SIDE * 2)
	const view = new DataView(pixels.buffer)

	for (let y = 0; y < SIDE; y++) {
		for (let x = 0; x < SIDE; x++) {
			const inside = Math.hypot(x - SIDE / 2, y - SIDE / 2) < SIDE / 3
			// Stored values are HU + 1024; air (-1000 HU) is 24.
			const stored = inside ? 1064 + ((x + y) % 64) : 24

			view.setUint16((y * SIDE + x) * 2, stored & 0xfff, true)
		}
	}

	return pixels
}

function ctElements(): DicomElement[] {
	return [
		...patient("CT"),
		...grayModule({ rows: SIDE, columns: SIDE, bitsAllocated: 16, bitsStored: 12, highBit: 11, signed: true }),
		text(0x00281050, "DS", "40"),
		text(0x00281051, "DS", "400"),
		text(0x00281052, "DS", "-1024"),
		text(0x00281053, "DS", "1")
	]
}

export function richCt(): Buffer {
	return Buffer.from(dicomFile({ transferSyntax: EXPLICIT_LE, elements: ctElements(), pixelData: ctPixels() }))
}

// The same CT image, its data set deflated.
export function richDeflate(): Buffer {
	return Buffer.from(dicomFile({ transferSyntax: DEFLATED, elements: ctElements(), pixelData: ctPixels() }))
}

// An RLE cine of 8 frames, 64×64 8-bit: a bright bar moving down.
export function richCine(): Buffer {
	const side = 64
	const frames = Array.from({ length: RICH_CINE_FRAMES }, (_, frame) => {
		const plane = new Uint8Array(side * side).fill(16)

		plane.fill(240, frame * 8 * side, (frame * 8 + 8) * side)

		return rleFrame([plane])
	})

	return Buffer.from(
		dicomFile({
			transferSyntax: RLE,
			elements: [
				...patient("XA"),
				...grayModule({
					rows: side,
					columns: side,
					bitsAllocated: 8,
					bitsStored: 8,
					highBit: 7,
					signed: false,
					frames: RICH_CINE_FRAMES
				}),
				text(0x00181063, "DS", "100")
			],
			pixelData: encapsulated(frames, frameOffsets(frames))
		})
	)
}

function wrapped(transferSyntax: string, file: string, elements: DicomElement[]): Buffer {
	return Buffer.from(dicomFile({ transferSyntax, elements, pixelData: encapsulated([readFileSync(`${CODESTREAMS}${file}`)]) }))
}

const RING = grayModule({ rows: 96, columns: 96, bitsAllocated: 16, bitsStored: 12, highBit: 11, signed: false })

export function richJls(): Buffer {
	return wrapped(JPEG_LS, "rich-jls.jls", [...patient("MR"), ...RING])
}

export function richJ2k(): Buffer {
	return wrapped(JPEG_2000, "rich-j2k.j2k", [...patient("MR"), ...RING])
}

// A baseline JPEG in YBR_FULL_422, decoded by the browser to RGB.
export function richColor(): Buffer {
	return wrapped(JPEG_BASELINE, "rich-color.jpg", [
		...patient("XC"),
		us(0x00280002, 3),
		text(0x00280004, "CS", "YBR_FULL_422"),
		us(0x00280006, 0),
		us(0x00280010, 96),
		us(0x00280011, 96),
		us(0x00280100, 8),
		us(0x00280101, 8),
		us(0x00280102, 7),
		us(0x00280103, 0)
	])
}
