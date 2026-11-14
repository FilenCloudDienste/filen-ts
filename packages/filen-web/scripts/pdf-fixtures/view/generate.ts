import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { gunzipSync } from "node:zlib"
import * as mupdf from "mupdf"
import { CJK_TEXT, cjkNonEmbedded, cmykDocument, jbig2Document, jpxDocument, latinDocument } from "./documents"

// The PDF viewer's checked-in fixtures (e2e/fixtures/pdf/view/) and their manifest. Sources and licences:
// - every document's structure, text and pictures: this directory's code (no third-party content);
// - cjk-embedded.pdf: a subset of Noto Sans JP (SIL Open Font License 1.1, @filen/office's
//   assets/fonts/noto/noto-sans-jp/OFL.txt), embedded and subset by MuPDF (the mupdf package);
// - jpx.pdf: a picture drawn here, encoded by OpenJPEG's opj_compress (BSD-2-Clause; `brew install openjpeg`);
// - jbig2.pdf: encoded by ./jbig2.ts.
// The large documents the ranged-viewing checks need are built at test time from latinDocument().
//
//   pnpm exec tsx scripts/pdf-fixtures/view/generate.ts

const OUT = join(import.meta.dirname, "../../../e2e/fixtures/pdf/view")
const require = createRequire(import.meta.url)

function cjkEmbedded(): Uint8Array {
	const fontDir = dirname(require.resolve("@filen/office/assets/fonts/manifest.json"))
	const face = gunzipSync(readFileSync(join(fontDir, "noto/noto-sans-jp/NotoSansJP-Regular.ttf.gz")))
	const font = new mupdf.Font("NotoSansJP", face)
	const document = new mupdf.PDFDocument()
	const fontRef = document.addFont(font)
	const latin = document.addSimpleFont(new mupdf.Font("Helvetica"), "Latin")
	const glyphs = Array.from(CJK_TEXT)
		.map(char => font.encodeCharacter(char).toString(16).padStart(4, "0"))
		.join("")
	const resources = document.addObject({ Font: { F1: fontRef, F2: latin } })
	const content = `BT /F2 18 Tf 72 720 Td (Embedded Japanese font) Tj ET\nBT /F1 36 Tf 72 640 Td <${glyphs}> Tj ET`
	const page = document.addPage([0, 0, 612, 792], 0, resources, content)

	document.insertPage(-1, page)
	document.subsetFonts()

	return document.saveToBuffer("garbage=compact,compress").asUint8Array().slice()
}

// A 320 x 200 colour picture: gradients and bars, as a binary PPM for opj_compress.
function jpx(): { jp2: Uint8Array; width: number; height: number } {
	const width = 320
	const height = 200
	const header = Buffer.from(`P6\n${String(width)} ${String(height)}\n255\n`, "latin1")
	const pixels = Buffer.alloc(width * height * 3)

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const at = (y * width + x) * 3
			const bar = Math.floor(x / 40) % 2 === 0

			pixels[at] = Math.round((x / width) * 255)
			pixels[at + 1] = Math.round((y / height) * 255)
			pixels[at + 2] = bar ? 200 : 40
		}
	}

	const dir = mkdtempSync(join(tmpdir(), "pdf-fixtures-"))
	const input = join(dir, "in.ppm")
	const output = join(dir, "out.jp2")

	writeFileSync(input, Buffer.concat([header, pixels]))
	execFileSync("opj_compress", ["-i", input, "-o", output, "-r", "20"], { stdio: ["ignore", "ignore", "inherit"] })

	const jp2 = new Uint8Array(readFileSync(output))

	rmSync(dir, { recursive: true, force: true })

	return { jp2, width, height }
}

const picture = jpx()
const fixtures: Record<string, { readonly bytes: Uint8Array; readonly checks: string }> = {
	"latin.pdf": { bytes: latinDocument({ pages: 12, imageSide: 0, linearized: false }), checks: "multi-page text, standard font" },
	"latin-linearized.pdf": {
		bytes: latinDocument({ pages: 12, imageSide: 0, linearized: true }),
		checks: "the linearized layout: page 1 from the file's start"
	},
	"cjk-non-embedded.pdf": { bytes: cjkNonEmbedded(), checks: "Adobe-Japan1 font not embedded: character maps" },
	"cjk-embedded.pdf": { bytes: cjkEmbedded(), checks: "embedded, subset CID font" },
	"jpx.pdf": { bytes: jpxDocument(picture.jp2, picture.width, picture.height), checks: "JPEG 2000 decoder" },
	"jbig2.pdf": { bytes: jbig2Document(), checks: "JBIG2 decoder" },
	"cmyk.pdf": { bytes: cmykDocument(), checks: "DeviceCMYK through the CMYK ICC profile" }
}

mkdirSync(OUT, { recursive: true })

const manifest: Record<string, { bytes: number; sha256: string; checks: string }> = {}

for (const [name, { bytes, checks }] of Object.entries(fixtures)) {
	writeFileSync(join(OUT, name), bytes)
	manifest[name] = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), checks }
}

writeFileSync(join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, "\t")}\n`)
