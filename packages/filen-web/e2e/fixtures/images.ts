import { gzipSync } from "node:zlib"
import { encodeQoi, qoiTestPixels } from "@/tests/support/qoiBytes"
import { JXL_PROBE_BASE64 } from "@/lib/imageProbeFixtures"
import { scenarioModule } from "./scenarios"

// The image spec's files (preview-images.spec.ts): formats only the app's own decoders show.

export const QOI_SIZE = { width: 96, height: 64 } as const

const SVGZ_TEXT = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#3a7"/></svg>'

export const IMAGE_SCENARIOS = scenarioModule(
	{
		"images-qoi": ["img-sample.qoi"],
		"images-jxl": ["img-sample.jxl"],
		"images-svgz": ["img-sample.svgz", "img-bomb.svgz"]
	},
	() => ({
		"img-sample.qoi": {
			buffer: Buffer.from(encodeQoi(qoiTestPixels(QOI_SIZE.width, QOI_SIZE.height), QOI_SIZE.width, QOI_SIZE.height)),
			mimeType: "image/x-qoi"
		},
		// The boot probe's own 1×1 image: whichever way this browser shows JPEG XL, it shows this.
		"img-sample.jxl": { buffer: Buffer.from(JXL_PROBE_BASE64, "base64"), mimeType: "image/jxl" },
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
		}
	})
)
