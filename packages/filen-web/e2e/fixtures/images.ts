import { crc32, deflateSync, gzipSync } from "node:zlib"
import { encodeQoi, qoiTestPixels } from "@/tests/support/qoiBytes"
import { bigTiffHeader, encodeTiff } from "@/tests/support/tiffBytes"
import { encodePsd } from "@/tests/support/psdBytes"
import { dosEps, epsiEps, plainEps } from "@/tests/support/epsBytes"
import { JPEG_BYTES, PDF_BYTES } from "../helpers/fixtureBytes"
import { JXL_PROBE_BASE64 } from "@/lib/imageProbeFixtures"
import { buildZip } from "../helpers/archiveFixtures"
import { scenarioModule } from "./scenarios"

// The image spec's files (preview-images.spec.ts): formats only the app's own decoders show.

export const QOI_SIZE = { width: 96, height: 64 } as const

export const TIFF_PAGE = { width: 120, height: 80 } as const

export const PSD_SIZE = { width: 90, height: 60 } as const

export const EPSI_WIDTH = 16

// 60 MP: a black 1-bit PNG, small on disk, 240 MB once the browser decodes it.
export const HUGE_PNG_SIZE = { width: 7800, height: 7800 } as const

const POSTSCRIPT_AI = "%!PS-Adobe-3.0\n%%Creator: Adobe Illustrator(R) 8.0\n%%BoundingBox: 0 0 100 100\n%%EndComments\n"
// Taller than a view, so stepping pages scrolls the column.
const TIFF_TALL_PAGE = { width: 200, height: 1600 } as const

const SVGZ_TEXT = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#3a7"/></svg>'

// Each format's sample, shared by the tree's files, the archive's entries and the specs' own uploads.
export function qoiSample(): Buffer {
	return Buffer.from(encodeQoi(qoiTestPixels(QOI_SIZE.width, QOI_SIZE.height), QOI_SIZE.width, QOI_SIZE.height))
}

export function jxlSample(): Buffer {
	return Buffer.from(JXL_PROBE_BASE64, "base64")
}

export function tiffSample(): Buffer {
	return Buffer.from(encodeTiff([{ ...TIFF_PAGE, rgb: [40, 120, 200] }]))
}

// A PNG chunk: its data's length, the type, the data, then a CRC over type and data.
function pngChunk(type: string, data: Buffer): Buffer {
	const body = Buffer.concat([Buffer.from(type, "latin1"), data])
	const head = Buffer.alloc(4)
	const tail = Buffer.alloc(4)

	head.writeUInt32BE(data.length)
	tail.writeUInt32BE(crc32(body))

	return Buffer.concat([head, body, tail])
}

// The huge PNG.
function hugePng(): Buffer {
	const { width, height } = HUGE_PNG_SIZE
	const header = Buffer.alloc(13)

	header.writeUInt32BE(width, 0)
	header.writeUInt32BE(height, 4)
	// Bit depth 1, greyscale; deflate, adaptive filtering, no interlace.
	header.set([1, 0, 0, 0, 0], 8)

	// Each row: filter type 0, then its bits, all 0 (black).
	const rows = Buffer.alloc((1 + Math.ceil(width / 8)) * height)

	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", header),
		pngChunk("IDAT", deflateSync(rows, { level: 9 })),
		pngChunk("IEND", Buffer.alloc(0))
	])
}

// The archive's entries, read through the entry origin.
export const IMAGE_ENTRIES = { qoi: "entry-sample.qoi", jxl: "entry-sample.jxl", tiff: "entry-single.tif" } as const

export const IMAGE_SCENARIOS = scenarioModule(
	{
		"images-qoi": ["img-sample.qoi"],
		"images-jxl": ["img-sample.jxl"],
		"images-svgz": ["img-sample.svgz", "img-bomb.svgz"],
		"images-tiff": ["img-single.tif", "img-multipage.tiff", "img-big.tif"],
		"images-archive": ["img-entries.zip"],
		"images-psd": ["img-flat.psd", "img-noflat.psd", "img-large.psb"],
		"images-ai": ["img-pdfcompat.ai", "img-postscript.ai"],
		"images-eps": ["img-dos.eps", "img-epsi.eps", "img-plain.eps"],
		"images-huge": ["img-60mp.png"]
	},
	() => ({
		"img-sample.qoi": { buffer: qoiSample(), mimeType: "image/x-qoi" },
		// The boot probe's own 1×1 image: whichever way this browser shows JPEG XL, it shows this.
		"img-sample.jxl": { buffer: jxlSample(), mimeType: "image/jxl" },
		"img-sample.svgz": { buffer: gzipSync(SVGZ_TEXT), mimeType: "image/svg+xml" },
		// 33 MiB of markup in a few dozen kilobytes: past what the preview inflates.
		"img-bomb.svgz": {
			buffer: gzipSync(
				Buffer.concat([
					Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">'),
					Buffer.alloc(33 * 1024 * 1024, 0x20),
					Buffer.from("</svg>")
				]),
				{
					level: 9
				}
			),
			mimeType: "image/svg+xml"
		},
		"img-single.tif": { buffer: tiffSample(), mimeType: "image/tiff" },
		"img-multipage.tiff": {
			buffer: Buffer.from(
				encodeTiff([
					{ ...TIFF_TALL_PAGE, rgb: [200, 40, 40] },
					{ ...TIFF_TALL_PAGE, rgb: [40, 200, 40] },
					{ ...TIFF_TALL_PAGE, rgb: [40, 40, 200] }
				])
			),
			mimeType: "image/tiff"
		},
		"img-big.tif": { buffer: Buffer.from(bigTiffHeader()), mimeType: "image/tiff" },
		// Its composite, and the JPEG thumbnail Photoshop embeds (resource 1036).
		"img-flat.psd": {
			buffer: Buffer.from(encodePsd(PSD_SIZE.width, PSD_SIZE.height, { thumbnail: { id: 1036, jpeg: new Uint8Array(JPEG_BYTES) } })),
			mimeType: "image/vnd.adobe.photoshop"
		},
		// Saved without "Maximize compatibility": no composite to show.
		"img-noflat.psd": {
			buffer: Buffer.from(encodePsd(PSD_SIZE.width, PSD_SIZE.height, { composite: false })),
			mimeType: "image/vnd.adobe.photoshop"
		},
		"img-large.psb": {
			buffer: Buffer.from(encodePsd(PSD_SIZE.width, PSD_SIZE.height, { version: 2 })),
			mimeType: "image/vnd.adobe.photoshop"
		},
		// Saved PDF-compatible: a PDF inside. Without it, PostScript only.
		"img-pdfcompat.ai": { buffer: PDF_BYTES, mimeType: "application/illustrator" },
		"img-postscript.ai": { buffer: Buffer.from(POSTSCRIPT_AI, "latin1"), mimeType: "application/illustrator" },
		"img-dos.eps": { buffer: Buffer.from(dosEps(tiffSample())), mimeType: "application/postscript" },
		// A 16 × 8 black frame on white, as the specification's example draws one (1 is black, 0 white).
		"img-epsi.eps": {
			buffer: Buffer.from(
				epsiEps(
					EPSI_WIDTH,
					1,
					Array.from({ length: 8 }, (_, row) => (row === 0 || row === 7 ? "FFFF" : "8001"))
				)
			),
			mimeType: "application/postscript"
		},
		"img-plain.eps": { buffer: Buffer.from(plainEps()), mimeType: "application/postscript" },
		"img-60mp.png": { buffer: hugePng(), mimeType: "image/png" },
		"img-entries.zip": {
			buffer: buildZip([
				{ name: IMAGE_ENTRIES.qoi, data: qoiSample() },
				{ name: IMAGE_ENTRIES.jxl, data: jxlSample() },
				{ name: IMAGE_ENTRIES.tiff, data: tiffSample() }
			]),
			mimeType: "application/zip"
		}
	})
)
