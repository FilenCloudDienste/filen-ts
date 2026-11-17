import { encodeQoi, qoiTestPixels } from "@/tests/support/qoiBytes"
import { scenarioModule } from "./scenarios"

// The image spec's files (preview-images.spec.ts): formats only the app's own decoders show.

export const QOI_SIZE = { width: 96, height: 64 } as const

export const IMAGE_SCENARIOS = scenarioModule(
	{
		"images-qoi": ["img-sample.qoi"]
	},
	() => ({
		"img-sample.qoi": {
			buffer: Buffer.from(encodeQoi(qoiTestPixels(QOI_SIZE.width, QOI_SIZE.height), QOI_SIZE.width, QOI_SIZE.height)),
			mimeType: "image/x-qoi"
		}
	})
)
