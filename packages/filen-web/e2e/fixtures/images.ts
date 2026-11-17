import { encodeQoi, qoiTestPixels } from "@/tests/support/qoiBytes"
import { JXL_PROBE_BASE64 } from "@/lib/imageProbeFixtures"
import { scenarioModule } from "./scenarios"

// The image spec's files (preview-images.spec.ts): formats only the app's own decoders show.

export const QOI_SIZE = { width: 96, height: 64 } as const

export const IMAGE_SCENARIOS = scenarioModule(
	{
		"images-qoi": ["img-sample.qoi"],
		"images-jxl": ["img-sample.jxl"]
	},
	() => ({
		"img-sample.qoi": {
			buffer: Buffer.from(encodeQoi(qoiTestPixels(QOI_SIZE.width, QOI_SIZE.height), QOI_SIZE.width, QOI_SIZE.height)),
			mimeType: "image/x-qoi"
		},
		// The boot probe's own 1×1 image: whichever way this browser shows JPEG XL, it shows this.
		"img-sample.jxl": { buffer: Buffer.from(JXL_PROBE_BASE64, "base64"), mimeType: "image/jxl" }
	})
)
