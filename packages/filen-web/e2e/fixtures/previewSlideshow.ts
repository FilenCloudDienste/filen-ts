import { JPEG_BYTES, MP4_BYTES, PNG_BYTES, TEXT_BYTES } from "../helpers/fixtureBytes"
import { scenarioModule } from "./scenarios"

// The slideshow spec's files (preview-slideshow.spec.ts), in the listing's name order: two images, a text file a
// slideshow passes over, a third image, then a video. Four slides of five files.
export const SLIDESHOW_SCENARIOS = scenarioModule(
	{
		"preview-slideshow": [
			"e2e-slideshow-1.png",
			"e2e-slideshow-2.jpg",
			"e2e-slideshow-3.txt",
			"e2e-slideshow-4.png",
			"e2e-slideshow-5.mp4"
		]
	},
	() => ({
		"e2e-slideshow-1.png": { buffer: PNG_BYTES, mimeType: "image/png" },
		"e2e-slideshow-2.jpg": { buffer: JPEG_BYTES, mimeType: "image/jpeg" },
		"e2e-slideshow-3.txt": { buffer: TEXT_BYTES, mimeType: "text/plain" },
		"e2e-slideshow-4.png": { buffer: PNG_BYTES, mimeType: "image/png" },
		"e2e-slideshow-5.mp4": { buffer: MP4_BYTES, mimeType: "video/mp4" }
	})
)
