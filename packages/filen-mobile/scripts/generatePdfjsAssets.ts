import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join, relative } from "node:path"

/**
 * Emits the pdf.js binary assets as an inlined base64 module.
 *
 * pdf.js normally fetches its fonts and wasm decoders from a URL at runtime. That cannot work in a
 * production DOM component: the document origin is file://, the WebView is configured to disallow
 * file->file reads, and pdf.js only treats http(s) as fetchable — so the URL path is dead in release
 * builds while appearing to work in development, where Metro serves the bundle over http. Handing the
 * bytes to pdf.js directly through a BinaryDataFactory removes the fetch entirely and makes the two
 * build types behave identically.
 *
 * The wasm decoders are NOT optional extras. In this version CCITTFax — ordinary G4 fax compression,
 * which is what a great many scanned documents use — is decoded through jbig2.wasm, and with no wasm
 * available those images are skipped silently: a scanned PDF renders as blank white pages with no
 * error at all. openjpeg covers JPEG2000 and qcms covers ICC colour.
 *
 * quickjs-eval.wasm sits in the same upstream directory and must NEVER be bundled — it is the PDF
 * scripting engine, and shipping it would hand a document an interpreter.
 *
 * cMaps are bundled as well. They matter for documents that reference a CJK encoding without
 * embedding the font, which for a cloud-storage app holding whatever its users put in it is not an
 * exotic case. Missing them degrades to missing glyphs rather than a blank page, but "some documents
 * render with holes in them" is not a good property for a file viewer.
 *
 * Not bundled, and not bundleable: the CMYK ICC profile. pdf.js reads it with a SYNCHRONOUS fetch
 * against a URL it builds by concatenation (`${iccUrl}CGATS001Compat-v2-micro.icc`), so it cannot be
 * served through the factory at all. Documents using an ICC-based CMYK colour space fall back to an
 * unmanaged conversion — slightly different colours, never a failure to render.
 *
 * Run after every pdfjs-dist bump. `pdfjsAssets.test.ts` fails if this output drifts from the
 * installed package.
 */

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const PDFJS_ROOT = join(PACKAGE_ROOT, "node_modules", "pdfjs-dist")
const FONT_DIRECTORY = join(PDFJS_ROOT, "standard_fonts")
const WASM_DIRECTORY = join(PDFJS_ROOT, "wasm")
const CMAP_DIRECTORY = join(PDFJS_ROOT, "cmaps")
const OUTPUT_FILE = join(PACKAGE_ROOT, "src", "components", "pdfPreview", "assets.generated.ts")

// Explicit allowlist rather than "everything in the directory": that directory also contains the
// scripting engine, and a future pdfjs release adding another file must not silently ship it.
export const BUNDLED_WASM = ["jbig2.wasm", "openjpeg.wasm", "qcms_bg.wasm"]

function encodeDirectory(directory: string, fileNames: string[]): { entries: string[]; bytes: number } {
	const entries = fileNames.map(fileName => {
		const contents = readFileSync(join(directory, fileName))

		return `\t"${fileName}": "${contents.toString("base64")}"`
	})

	const bytes = fileNames.reduce((total, fileName) => total + statSync(join(directory, fileName)).size, 0)

	return {
		entries,
		bytes
	}
}

function main(): void {
	for (const directory of [FONT_DIRECTORY, WASM_DIRECTORY, CMAP_DIRECTORY]) {
		if (!existsSync(directory)) {
			throw new Error(`pdfjs-dist assets not found at ${directory} — is pdfjs-dist installed?`)
		}
	}

	// LICENSE_* are attribution text, never requested by name at runtime. They stay in node_modules and
	// must be reflected in the app's third-party notices rather than shipped through this map.
	const fontNames = readdirSync(FONT_DIRECTORY)
		.filter(fileName => !fileName.startsWith("LICENSE"))
		.sort()

	const missing = BUNDLED_WASM.filter(fileName => !existsSync(join(WASM_DIRECTORY, fileName)))

	if (missing.length > 0) {
		throw new Error(`expected wasm assets are missing from pdfjs-dist: ${missing.join(", ")}`)
	}

	const cMapNames = readdirSync(CMAP_DIRECTORY)
		.filter(fileName => fileName.endsWith(".bcmap"))
		.sort()

	const fonts = encodeDirectory(FONT_DIRECTORY, fontNames)
	const wasm = encodeDirectory(WASM_DIRECTORY, BUNDLED_WASM)
	const cMaps = encodeDirectory(CMAP_DIRECTORY, cMapNames)

	const output = [
		"// GENERATED FILE — do not edit. Produced by scripts/generatePdfjsAssets.ts.",
		"",
		"export const STANDARD_FONTS: Record<string, string> = {",
		fonts.entries.join(",\n"),
		"}",
		"",
		"export const WASM_BINARIES: Record<string, string> = {",
		wasm.entries.join(",\n"),
		"}",
		"",
		"export const CMAPS: Record<string, string> = {",
		cMaps.entries.join(",\n"),
		"}",
		""
	].join("\n")

	mkdirSync(dirname(OUTPUT_FILE), {
		recursive: true
	})

	writeFileSync(OUTPUT_FILE, output, "utf-8")

	console.log(
		`wrote ${fontNames.length} fonts (${(fonts.bytes / 1024).toFixed(0)}KB) + ${BUNDLED_WASM.length} wasm (${(wasm.bytes / 1024).toFixed(0)}KB) + ${cMapNames.length} cmaps (${(cMaps.bytes / 1024).toFixed(0)}KB) -> ${relative(PACKAGE_ROOT, OUTPUT_FILE)}`
	)
}

main()
