import { describe, expect, test } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { buildPdfDocumentOptions } from "@/components/pdfPreview/options"

/**
 * The security-critical pdf.js configuration, asserted as literal values.
 *
 * These are the settings a reviewer would otherwise have to re-derive from a large component every
 * time it changes. Each assertion names the attack or the failure mode it prevents, so a future
 * change that trips one of these has to argue with the reason rather than just update the number.
 */
describe("pdf viewer options", () => {
	const options = buildPdfDocumentOptions({
		binaryDataFactory: class {},
		range: {}
	})

	test("pins useWorkerFetch off rather than letting pdf.js infer it", () => {
		// Inference is by whether the asset URLs look fetchable, which is true under Metro (http) and
		// false in release (file://). Left to infer, the viewer takes a different code path in
		// development than in production — the exact failure this whole design avoids.
		expect(options["useWorkerFetch"]).toBe(false)
	})

	test("forces bundled standard fonts", () => {
		// Left on, base-14 fonts resolve from the platform's own fonts, which differ between iOS and
		// Android — so the same document lays out differently on each.
		expect(options["useSystemFonts"]).toBe(false)
	})

	test("sets disableStream and disableAutoFetch together", () => {
		// Either one alone is a no-op inside pdf.js.
		expect(options["disableStream"]).toBe(true)
		expect(options["disableAutoFetch"]).toBe(true)
	})

	test("bounds decoded image size", () => {
		// pdf.js defaults to unlimited, so a document can otherwise declare an enormous image and force
		// the allocation.
		expect(typeof options["maxImageSize"]).toBe("number")
		expect(options["maxImageSize"]).toBeGreaterThan(0)
		expect(Number.isFinite(options["maxImageSize"])).toBe(true)
	})

	test("keeps XFA off", () => {
		// XFA is a second, scriptable form engine.
		expect(options["enableXfa"]).toBe(false)
	})

	test("never passes a password or a docBaseUrl", () => {
		// Passwords arrive through onPassword so they never sit in an options object; docBaseUrl is
		// overridable from the document's own catalog and is what relative URLs resolve against.
		expect("password" in options).toBe(false)
		expect("docBaseUrl" in options).toBe(false)
	})

	test("never enables scripting", () => {
		// Not a getDocument parameter at all — it belongs to the annotation layer, whose own default is
		// opt-in. Present here it would be misleading; present and true it would be the CVE.
		expect("enableScripting" in options).toBe(false)
	})

	test("supplies a binary data factory, so nothing is resolved by URL", () => {
		expect(options["BinaryDataFactory"]).toBeTruthy()
	})
})

/**
 * A build-time tripwire, not a behavioural test.
 *
 * pdfjs-dist ships its viewer application TWICE — `web/pdf_viewer.mjs` and `legacy/web/pdf_viewer.mjs`
 * — and both carry `enableScripting: true` as a default, the setting behind CVE-2026-16633. We ship
 * the legacy tree, so the legacy copy is the one an import would most plausibly reach by accident.
 *
 * Matching on module paths and not on the string `enableScripting`: that string appears legitimately
 * in the core annotation layer, whose own default is opt-in, so a naive content grep would fire on
 * correct code and be switched off.
 */
describe("pdf viewer import tripwire", () => {
	const BANNED = [/pdfjs-dist\/(legacy\/)?web\//, /pdf_viewer/, /pdf\.sandbox/, /quickjs/]

	// Import specifiers only, never raw file contents: prose naming these modules — including this
	// test, and the comments explaining why they are banned — is not an import, and a check that
	// fired on documentation would be turned off within a week.
	const SPECIFIER = /(?:\bfrom\s*|\bimport\s*|\brequire\(\s*)["']([^"']+)["']/g

	function collect(directory: string): string[] {
		const files: string[] = []

		for (const entry of readdirSync(directory)) {
			const path = join(directory, entry)

			// The test tree is not shipped and never reaches a bundle; scanning it would only catch this
			// file's own self-test fixtures below.
			if (entry === "tests") {
				continue
			}

			if (statSync(path).isDirectory()) {
				files.push(...collect(path))
			} else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".generated.ts")) {
				files.push(path)
			}
		}

		return files
	}

	test("no source file imports the pdf.js viewer application or its scripting sandbox", () => {
		const offenders: string[] = []

		for (const file of collect(join(process.cwd(), "src"))) {
			const contents = readFileSync(file, "utf-8")

			for (const match of contents.matchAll(SPECIFIER)) {
				const specifier = match[1] ?? ""

				if (BANNED.some(pattern => pattern.test(specifier))) {
					offenders.push(`${file}: ${specifier}`)
				}
			}
		}

		expect(offenders).toStrictEqual([])
	})

	test("the tripwire actually catches a banned specifier", () => {
		// Without this, a regex that silently stopped matching would leave the suite green forever.
		const banned = ['import x from "pdfjs-dist/legacy/web/pdf_viewer.mjs"', 'import y from "pdfjs-dist/web/pdf_viewer.mjs"']

		for (const line of banned) {
			const specifiers = [...line.matchAll(SPECIFIER)].map(match => match[1] ?? "")

			expect(specifiers.some(specifier => BANNED.some(pattern => pattern.test(specifier)))).toBe(true)
		}
	})
})
