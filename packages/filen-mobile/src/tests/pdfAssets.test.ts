import { describe, expect, test } from "vitest"
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { STANDARD_FONTS, WASM_BINARIES } from "@/components/pdfPreview/assets.generated"

const PDFJS_ROOT = join(process.cwd(), "node_modules", "pdfjs-dist")

/**
 * Guards the generated asset payload against drifting from the installed pdfjs-dist.
 *
 * The failure this prevents is silent: bump the package, forget to re-run the generator, and the
 * viewer keeps serving the previous version's fonts. Nothing throws — glyphs are subtly wrong, or a
 * newly-required decoder is simply absent and scanned pages come out blank.
 */
describe("pdf.js asset payload", () => {
	test("bundles every standard font the installed package ships", () => {
		const expected = readdirSync(join(PDFJS_ROOT, "standard_fonts"))
			.filter(fileName => !fileName.startsWith("LICENSE"))
			.sort()

		expect(Object.keys(STANDARD_FONTS).sort()).toStrictEqual(expected)
	})

	test("bundles the wasm decoders", () => {
		// jbig2 is not optional: in this version ordinary CCITTFax (G4 fax compression, used by a great
		// many scanned documents) decodes through it, and without it those images are skipped silently —
		// the page renders blank white with no error.
		expect(Object.keys(WASM_BINARIES).sort()).toStrictEqual(["jbig2.wasm", "openjpeg.wasm", "qcms_bg.wasm"])

		for (const fileName of Object.keys(WASM_BINARIES)) {
			expect(existsSync(join(PDFJS_ROOT, "wasm", fileName))).toBe(true)
		}
	})

	test("never bundles the pdf scripting engine", () => {
		// quickjs-eval.wasm sits in the same upstream directory as the decoders. Shipping it would hand
		// an attacker-authored document an interpreter.
		expect(Object.keys(WASM_BINARIES)).not.toContain("quickjs-eval.wasm")

		for (const encoded of Object.values(WASM_BINARIES)) {
			expect(encoded.length).toBeGreaterThan(0)
		}
	})

	test("payload entries are non-empty base64", () => {
		for (const [name, encoded] of Object.entries(STANDARD_FONTS)) {
			expect(encoded.length, name).toBeGreaterThan(0)
			expect(/^[A-Za-z0-9+/]+=*$/.test(encoded), name).toBe(true)
		}
	})
})
