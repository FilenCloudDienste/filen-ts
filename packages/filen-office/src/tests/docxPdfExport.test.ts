import { describe, expect, it } from "vitest"
import type { FontExtents, TextMeasurer } from "../core/text/index"
import { DocxEngine, type DocxEngineServices, type DocxWorkerLike } from "../dom/docx/index"
import { exportDocxPdf, serveDocxPdfWorker } from "../dom/docx/pdf"
import { DocxPdfExportError, docxPdfSnapshot, exportDocxPdfInWorker } from "../dom/docx/pdfClient"
import { bytesSource } from "../core/opc/index"
import { OPS as pdfjsOps } from "pdfjs-dist/legacy/build/pdf.mjs"
import { buildDocx } from "./docxSynthetic"
import { openPdf, pageText, pdfAssets, snapshotOf, structuredDocx } from "./docxPdfFixtures"

const measurer: TextMeasurer = {
	kerningControl: true,
	measure(font, _kerning, texts, count, widths) {
		const size = Number(/([\d.]+)px/.exec(font)?.[1] ?? "16")

		for (let i = 0; i < count; i++) widths[i] = (texts[i] ?? "").length * size * 0.5
	},
	fontExtents(font): FontExtents {
		const size = Number(/([\d.]+)px/.exec(font)?.[1] ?? "16")

		return { ascent: size * 0.8, descent: size * 0.2 }
	}
}

function services(): DocxEngineServices {
	return {
		fontHost: { addBytes: () => Promise.resolve(true), addLocal: () => Promise.resolve(false), remove: () => undefined },
		replayFonts: false,
		fontAssets: { read: () => Promise.resolve(new Uint8Array(4)) },
		measurer,
		yield: () => new Promise(resolve => setTimeout(resolve, 0)),
		sliceMs: 8
	}
}

// The page and the worker on one realm: each side's posts reach the other a turn later.
function channel(): () => DocxWorkerLike {
	return () => {
		let toPage: ((data: unknown) => void) | undefined
		let toWorker: ((data: unknown) => void) | undefined

		serveDocxPdfWorker(
			{
				post: message => setTimeout(() => toPage?.(message), 0),
				listen: onMessage => {
					toWorker = onMessage
				}
			},
			() => services(),
			pdfAssets
		)

		return {
			post: message => setTimeout(() => toWorker?.(message), 0),
			listen: onMessage => {
				toPage = onMessage
			},
			terminate: () => {
				toPage = undefined
			}
		}
	}
}

async function bytesOf(blob: { arrayBuffer(): Promise<ArrayBuffer> }): Promise<Uint8Array> {
	return new Uint8Array(await blob.arrayBuffer())
}

describe("PDF export of a document", () => {
	it("opens, lays out and paints a document given as bytes, laying out before the pages are counted", async () => {
		const phases: string[] = []
		const exported = await exportDocxPdf(structuredDocx(), services(), pdfAssets, {
			options: { title: "Report", deterministic: true },
			signal: { aborted: false },
			onProgress: phase => {
				if (phases.at(-1) !== phase) phases.push(phase)
			}
		})
		const pdf = await openPdf(await bytesOf(exported.blob))

		expect(phases).toEqual(["layout", "pages"])
		expect(await pageText(pdf, 1)).toContain("Introduction")
		expect(exported.blob.type).toBe("application/pdf")
	})

	it("titles the PDF of a document naming no title with its file name, so it may claim PDF/UA", async () => {
		const docx = buildDocx({ body: "<w:p><w:r><w:t>Untitled</w:t></w:r></w:p>" })
		const exported = await exportDocxPdf(docx, services(), pdfAssets, {
			options: { title: "Letter to Ann", deterministic: true },
			signal: { aborted: false }
		})
		const pdf = await openPdf(await bytesOf(exported.blob))
		const metadata = await pdf.getMetadata()

		expect((metadata.info as { Title?: string }).Title).toBe("Letter to Ann")
		expect(metadata.metadata?.get("dc:title")).toBe("Letter to Ann")
		expect((await pdf.getViewerPreferences())?.get("DisplayDocTitle")).toBe(true)
		expect(metadata.metadata?.get("pdfuaid:part")).toBe("1")
	})

	it("runs in the PDF worker and hands back the Blob", async () => {
		const progress: number[] = []
		const result = await exportDocxPdfInWorker(channel(), {
			input: { kind: "bytes", bytes: structuredDocx() },
			options: { title: "Report" },
			onProgress: p => {
				if (p.phase === "pages") progress.push(p.done)
			}
		})

		expect(progress.at(-1)).toBeGreaterThan(0)
		expect(await pageText(await openPdf(await bytesOf(result.blob)), 1)).toContain("Running footer")
	})

	it("paints an editor's snapshot in the worker as it was laid out", async () => {
		const engine = new DocxEngine(bytesSource(structuredDocx()), services(), () => undefined, { retain: true, view: "final" })

		await engine.run()

		const live = engine.pdfSource()

		expect(live).toBeDefined()

		if (live === undefined) return

		const document = await docxPdfSnapshot(live, { title: "Report", copy: true })

		engine.close()

		const result = await exportDocxPdfInWorker(channel(), { input: { kind: "snapshot", document }, options: { title: "Report" } })

		expect(await pageText(await openPdf(await bytesOf(result.blob)), 1)).toContain("Alpha")
	})

	it("gives the host a turn while snapshotting only once a slice is up", async () => {
		const engine = new DocxEngine(
			bytesSource(structuredDocx({ extraBody: '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'.repeat(5) })),
			services(),
			() => undefined,
			{
				retain: true,
				view: "final"
			}
		)

		await engine.run()

		const live = engine.pdfSource()

		if (live === undefined) throw new Error("Not laid out")

		const pauses = async (sliceMs: number): Promise<number> => {
			let count = 0
			let clock = 0

			await docxPdfSnapshot(live, {
				title: "Report",
				slicing: {
					pause: () => {
						count++

						return Promise.resolve()
					},
					sliceMs,
					now: () => (clock += 1)
				}
			})

			return count
		}

		const pages = (await docxPdfSnapshot(live, { title: "Report" })).pages.length

		expect(pages).toBeGreaterThan(4)
		expect(await pauses(1_000_000)).toBe(0)
		expect(await pauses(1)).toBe(pages)
		engine.close()
	})

	it("stops a cancelled export with an abort", async () => {
		const controller = new AbortController()
		const running = exportDocxPdfInWorker(channel(), {
			input: { kind: "bytes", bytes: structuredDocx() },
			options: { title: "Report" },
			signal: controller.signal
		})

		controller.abort()

		await expect(running).rejects.toMatchObject({ reason: "aborted" })
	})

	it("draws an equation from the math layout: its tokens, its fraction bar, tagged as a formula with its text", async () => {
		const M = "http://schemas.openxmlformats.org/officeDocument/2006/math"
		const docx = buildDocx({
			body: `<w:p><w:r><w:t xml:space="preserve">Ratio </w:t></w:r><m:oMath xmlns:m="${M}"><m:f><m:num><m:r><m:t>a</m:t></m:r></m:num><m:den><m:r><m:t>b</m:t></m:r></m:den></m:f></m:oMath></w:p>`
		})
		const exported = await exportDocxPdf(docx, services(), pdfAssets, {
			options: { title: "Report", deterministic: true },
			signal: { aborted: false }
		})
		const bytes = await bytesOf(exported.blob)
		const pdf = await openPdf(bytes)
		const roles: string[] = []
		const visit = (node: unknown): void => {
			const element = node as { role?: string; children?: unknown[] }

			if (typeof element.role === "string") roles.push(element.role)

			for (const child of element.children ?? []) visit(child)
		}

		visit(await (await pdf.getPage(1)).getStructTree())

		const text = await pageText(pdf, 1)
		const operators = (await (await pdf.getPage(1)).getOperatorList()).fnArray

		expect(roles).toContain("Formula")
		expect(text).toMatch(/a\s*b/)
		// The fraction bar is a filled rectangle beside the page's other paths.
		expect(operators.filter(op => op === pdfjsOps.constructPath).length).toBeGreaterThan(0)
	})

	it("draws an equation's set and logic operators with real glyphs", async () => {
		const M = "http://schemas.openxmlformats.org/officeDocument/2006/math"
		const docx = buildDocx({
			body: `<w:p><m:oMath xmlns:m="${M}"><m:r><m:t>∀x∈A∃y⊂B⇒x≤y</m:t></m:r></m:oMath></w:p>`
		})
		const exported = await exportDocxPdf(docx, services(), pdfAssets, {
			options: { title: "Equation", deterministic: true },
			signal: { aborted: false }
		})
		const text = await pageText(await openPdf(await bytesOf(exported.blob)), 1)

		expect(exported.report.missing.size).toBe(0)

		for (const char of ["∀", "∈", "∃", "⊂", "⇒"]) expect(text).toContain(char)
	})

	it("exports the Final view of a document shown with its markup, laid out again apart", async () => {
		const docx = buildDocx({
			body:
				'<w:p><w:r><w:t xml:space="preserve">Kept </w:t></w:r><w:del w:id="1" w:author="A"><w:r><w:delText>removed</w:delText></w:r></w:del>' +
				'<w:ins w:id="2" w:author="A"><w:r><w:t>added</w:t></w:r></w:ins></w:p>'
		})
		const engine = new DocxEngine(bytesSource(docx), services(), () => undefined, { retain: true, view: "markup" })

		await engine.run()

		const shown = engine.pdfSource()
		const live = await engine.pdfFinalSource(false)

		expect(shown?.layout.pages[0]?.sourceTexts.join("")).toContain("removed")
		expect(live?.layout).not.toBe(shown?.layout)

		if (live === undefined) return

		const result = await exportDocxPdfInWorker(channel(), {
			input: { kind: "snapshot", document: await docxPdfSnapshot(live, { title: "Report", copy: true }) },
			options: { title: "Report" }
		})

		engine.close()

		const text = await pageText(await openPdf(await bytesOf(result.blob)), 1)

		expect(text).toContain("added")
		expect(text).not.toContain("removed")
	})

	it("refuses a document that cannot be opened with its reason", async () => {
		await expect(
			exportDocxPdfInWorker(channel(), {
				input: { kind: "bytes", bytes: new Uint8Array([1, 2, 3, 4]) },
				options: { title: "Report" }
			})
		).rejects.toBeInstanceOf(DocxPdfExportError)
	})

	it("encrypts with the password it is given", async () => {
		const result = await exportDocxPdfInWorker(channel(), {
			input: { kind: "bytes", bytes: structuredDocx() },
			options: { title: "Report", password: "pw 1" }
		})
		const bytes = await bytesOf(result.blob)

		await expect(openPdf(bytes)).rejects.toThrow()
		expect(await pageText(await openPdf(bytes, "pw 1"), 1)).toContain("Introduction")
	})

	it("refuses a password SASLprep prohibits with its own reason, for a file and for a snapshot", async () => {
		// Hebrew and Latin letters together: SASLprep's bidi rule (RFC 3454 §6) refuses it.
		const options = { title: "Report", password: "שלוםabc" }
		const reason = (running: Promise<unknown>): Promise<unknown> =>
			running.then(
				() => "exported",
				(error: unknown) => (error instanceof DocxPdfExportError ? error.reason : error)
			)

		expect(await reason(exportDocxPdfInWorker(channel(), { input: { kind: "bytes", bytes: structuredDocx() }, options }))).toBe(
			"passwordUnsupported"
		)
		expect(
			await reason(
				exportDocxPdfInWorker(channel(), { input: { kind: "snapshot", document: await snapshotOf(structuredDocx()) }, options })
			)
		).toBe("passwordUnsupported")
	})
})
