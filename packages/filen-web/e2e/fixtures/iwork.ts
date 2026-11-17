import { buildZip, prng } from "../helpers/archiveFixtures"
import { JPEG_BYTES, PDF_BYTES } from "../helpers/fixtureBytes"
import { scenarioModule } from "./scenarios"

// The iWork spec's documents (preview-iwork.spec.ts): packages of each generation, each holding the rendering of itself
// the preview shows, one holding none, and a key file that only shares Keynote's extension. iWork stores its entries
// uncompressed, as these do.

// A private key's armour: what a `.key` that is no Keynote package usually holds.
export const IWORK_KEY_FILE_TEXT = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIA==\n-----END PRIVATE KEY-----\n"

// The document's own content, which only its app reads: opaque bytes.
function indexEntry(seed: number) {
	return { name: "Index/Document.iwa", data: prng(seed)(4096), method: "stored" as const }
}

export const IWORK_SCENARIOS = scenarioModule(
	{
		"iwork-documents": ["iwork-report.pages", "iwork-slides.key", "iwork-legacy.numbers", "iwork-bare.pages", "iwork-server.key"]
	},
	() => ({
		// '13 and later: images of the first page at three sizes.
		"iwork-report.pages": {
			buffer: buildZip([
				indexEntry(1),
				{ name: "preview.jpg", data: JPEG_BYTES, method: "stored" },
				{ name: "preview-web.jpg", data: JPEG_BYTES, method: "stored" },
				{ name: "preview-micro.jpg", data: JPEG_BYTES, method: "stored" }
			]),
			mimeType: "application/vnd.apple.pages"
		},
		// Browsers type a .key by its extension alone; only its first bytes say it is a package.
		"iwork-slides.key": {
			buffer: buildZip([indexEntry(2), { name: "preview.jpg", data: JPEG_BYTES, method: "stored" }]),
			mimeType: "application/octet-stream"
		},
		// '09: a PDF copy of the document and a thumbnail.
		"iwork-legacy.numbers": {
			buffer: buildZip([
				{ name: "index.xml.gz", data: prng(3)(2048), method: "stored" },
				{ name: "QuickLook/Thumbnail.jpg", data: JPEG_BYTES, method: "stored" },
				{ name: "QuickLook/Preview.pdf", data: PDF_BYTES, method: "stored" }
			]),
			mimeType: "application/vnd.apple.numbers"
		},
		// A package without a rendering of itself.
		"iwork-bare.pages": { buffer: buildZip([indexEntry(4)]), mimeType: "application/vnd.apple.pages" },
		"iwork-server.key": { buffer: Buffer.from(IWORK_KEY_FILE_TEXT, "utf8"), mimeType: "application/octet-stream" }
	})
)
