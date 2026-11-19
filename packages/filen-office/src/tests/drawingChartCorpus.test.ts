import { existsSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { parseTheme } from "../core/docx/index"
import { convertChart } from "../core/drawingml/chart/index"
import { drawingTheme } from "../core/drawingml/color"
import { DrawingList } from "../core/drawingml/displayList"
import { OpcPackage, bytesSource } from "../core/opc/index"
import type { XmlDocument } from "../core/xml/index"
import { CORPUS_DIR as CORPUS, corpusFiles } from "./corpusDir"

// The licensed real-world corpus is kept out of the repository; this sweep runs only where it exists.
const EXTENSIONS = ["docx", "docm", "dotx", "dotm", "xlsx", "xlsm"]
const CHART_PART = /^(word|xl)\/charts\/chart[^/]*\.xml$/
const THEME_PART = /^(word|xl)\/theme\/theme1\.xml$/

describe.skipIf(!existsSync(CORPUS))("charts over the real-world corpus", () => {
	it("converts every cached chart part", { timeout: 300_000 }, async () => {
		let found = 0
		let supported = 0
		let items = 0
		const kinds = new Map<string, number>()
		const unsupported = new Map<string, number>()
		const failures: string[] = []

		for (const file of corpusFiles(EXTENSIONS)) {
			const name = file.slice(CORPUS.length + 1)
			let opc: OpcPackage

			try {
				opc = await OpcPackage.open(bytesSource(new Uint8Array(readFileSync(file))))
			} catch {
				continue
			}

			const charts = opc.zip.entries.filter(entry => CHART_PART.test(entry.name))

			if (charts.length === 0) continue

			const themeEntry = opc.zip.entries.find(entry => THEME_PART.test(entry.name))
			let themeDocument: XmlDocument | undefined

			try {
				themeDocument = themeEntry === undefined ? undefined : await opc.xml(themeEntry.name)
			} catch {
				themeDocument = undefined
			}

			const parsed = themeDocument === undefined ? undefined : parseTheme(themeDocument)
			const theme = drawingTheme(themeDocument, scheme => parsed?.schemeColor(scheme))

			for (const entry of charts) {
				let document: XmlDocument

				try {
					document = await opc.xml(entry.name)
				} catch {
					continue
				}

				found++

				try {
					const list = new DrawingList()
					const result = convertChart({ list, theme, images: () => undefined, effects: false }, document, 4572000, 2743200)

					for (const plot of result.plots) kinds.set(plot, (kinds.get(plot) ?? 0) + 1)
					for (const kind of result.unsupported) unsupported.set(kind, (unsupported.get(kind) ?? 0) + 1)

					if (result.supported) supported++

					items += list.itemCount

					// Every coordinate and bound is a finite number.
					if (
						!list.coords.subarray(0, list.coordCount).every(Number.isFinite) ||
						!list.itemBounds.subarray(0, list.itemCount * 4).every(Number.isFinite)
					) {
						failures.push(`${name} ${entry.name}: non-finite geometry`)
					}
				} catch (error) {
					failures.push(`${name} ${entry.name}: ${String(error)}`)
				}
			}
		}

		console.log(
			`Chart corpus: ${found} chart parts; ${supported} drawn, ${found - supported} not drawn; ${items} items; plots ${JSON.stringify(Object.fromEntries(kinds))}; unsupported ${JSON.stringify(Object.fromEntries(unsupported))}`
		)

		expect(failures).toEqual([])
		// Fewer means lost coverage: the corpus holds about 1370 chart parts.
		expect(found).toBeGreaterThanOrEqual(1300)
	})
})
