import { existsSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { DocxDrawings } from "../core/docx/drawing"
import { Item, buildDocxModel, openDocxPackage } from "../core/docx/index"
import { ItemKind } from "../core/drawingml/displayList"
import { assertMathTree } from "../core/math/index"
import { bytesSource } from "../core/opc/index"
import { CORPUS_DIR as CORPUS, corpusFiles } from "./corpusDir"

// Every drawing, VML shape and equation of the real-world corpus through the docx bridge; runs only where
// the corpus exists.
const EXTENSIONS = ["docx", "docm", "dotx", "dotm"]

function bump(counts: Record<string, number>, key: string, by: number = 1): void {
	counts[key] = (counts[key] ?? 0) + by
}

describe.skipIf(!existsSync(CORPUS))("drawings over the real-world corpus", () => {
	it("converts every drawing, VML shape and equation without throwing", { timeout: 600_000 }, async () => {
		const failures: string[] = []
		const drawings: Record<string, number> = {}
		const vml: Record<string, number> = {}
		const math: Record<string, number> = {}
		const items: Record<string, number> = {}
		const images: Record<string, number> = {}
		const files = new Set<string>()
		let elapsed = 0

		for (const file of corpusFiles(EXTENSIONS)) {
			const name = file.slice(CORPUS.length + 1)
			const opened = await openDocxPackage(bytesSource(new Uint8Array(readFileSync(file))))

			if (!opened.ok) continue

			try {
				const model = await buildDocxModel(opened.package)
				const start = performance.now()
				const bridge = await DocxDrawings.open(model)
				const tally = (list: { itemCount: number; kind(item: number): number; images: readonly { handling: string }[] }): void => {
					for (let item = 0; item < list.itemCount; item++) {
						const kind = list.kind(item)

						bump(items, kind === ItemKind.PATH ? "path" : kind === ItemKind.IMAGE ? "image" : "text")
					}

					for (const image of list.images) bump(images, image.handling)
				}

				for (const info of model.drawings) {
					const result = await bridge.drawing(info)

					if (result.kind === "drawing") {
						bump(drawings, `${info.graphic}:drawn`)
						tally(result.list)

						if (result.unsupported > 0) bump(drawings, `${info.graphic}:partial`)
					} else {
						bump(drawings, `${info.graphic}:${result.reason}`)
					}

					files.add(name)
				}

				for (const info of model.vml) {
					const result = bridge.vml(info)

					if (result.kind === "drawing") {
						bump(vml, `${info.kind}:drawn`)
						tally(result.list)
					} else {
						bump(vml, `${info.kind}:${result.reason}`)
					}

					files.add(name)
				}

				for (const part of model.parts) {
					for (let item = 0; item < part.count; item++) {
						const kind = part.kinds[item]

						if (kind !== Item.Math && kind !== Item.MathParagraph) continue

						const tree = bridge.math(part.index, part.nodes[item] ?? -1)

						if (tree === undefined) {
							bump(math, "empty")
						} else {
							assertMathTree(tree)
							bump(math, "converted")
						}
					}
				}

				elapsed += performance.now() - start
			} catch (error) {
				failures.push(`${name}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
			}
		}

		console.log(
			`drawing corpus: ${files.size} files with drawings, ${elapsed.toFixed(0)} ms converting\n` +
				`drawings ${JSON.stringify(drawings)}\nvml ${JSON.stringify(vml)}\nmath ${JSON.stringify(math)}\n` +
				`items ${JSON.stringify(items)}\nimages ${JSON.stringify(images)}`
		)

		expect(failures).toEqual([])
		// Fewer means lost coverage: about 150 corpus documents hold drawings, VML shapes or equations.
		expect(files.size).toBeGreaterThanOrEqual(140)
	})
})
