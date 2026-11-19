import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { unzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { DocxDrawings } from "../core/docx/drawing"
import { buildDocxModel, openDocxPackage } from "../core/docx/index"
import { ItemKind, type DrawingList } from "../core/drawingml/displayList"
import { convertMetafile } from "../core/metafile/index"
import { bytesSource } from "../core/opc/index"
import { CORPUS_DIR as CORPUS, corpusFiles } from "./corpusDir"

// Every EMF/WMF picture of the real-world corpus through the converter (once per distinct file), then the
// documents holding them through the docx bridge; runs only where the corpus exists.
const EXTENSIONS = ["docx", "docm", "dotx", "dotm"]
const METAFILE = /\.(emf|wmf|emz|wmz)$/i

function bump(counts: Record<string, number>, key: string, by: number = 1): void {
	counts[key] = (counts[key] ?? 0) + by
}

function percentile(sorted: readonly number[], fraction: number): number {
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0
}

// Whether the bytes carry MathType's signature (its equation data rides in the picture's comments).
function isMathType(bytes: Uint8Array): boolean {
	const needle = [0x4d, 0x61, 0x74, 0x68, 0x54, 0x79, 0x70, 0x65]

	outer: for (let at = 0; at + needle.length <= Math.min(bytes.length, 4096); at++) {
		for (let k = 0; k < needle.length; k++) if (bytes[at + k] !== needle[k]) continue outer

		return true
	}

	return false
}

function glyphText(list: DrawingList): string[] {
	const out: string[] = []

	for (const text of list.texts) if (text.kind === "glyphs") out.push(text.run.text)

	return out
}

const PRIVATE_USE = /[-]/
const MATH = /[Α-ω∀-⋿…⎛-⎭]/

describe.skipIf(!existsSync(CORPUS))("metafiles over the real-world corpus", () => {
	it("converts every distinct metafile, drawing equation symbols as Unicode", { timeout: 600_000 }, async () => {
		const unique = new Map<string, { name: string; bytes: Uint8Array }>()
		const holders = new Set<string>()
		let parts = 0

		for (const file of corpusFiles(EXTENSIONS)) {
			let entries: Record<string, Uint8Array>

			try {
				entries = unzipSync(new Uint8Array(readFileSync(file)), { filter: entry => METAFILE.test(entry.name) })
			} catch {
				continue
			}

			for (const [partName, bytes] of Object.entries(entries)) {
				const key = createHash("sha1").update(bytes).digest("hex")

				parts++
				holders.add(file)

				if (!unique.has(key)) unique.set(key, { name: `${file.slice(CORPUS.length + 1)}:${partName}`, bytes })
			}
		}

		const failures: string[] = []
		const formats: Record<string, number> = {}
		const times: number[] = []
		let truncated = 0
		let withUnsupported = 0
		let empty = 0
		let items = 0
		let mathTypeFiles = 0
		let mathRuns = 0
		const privateUse: string[] = []

		for (const { name, bytes } of unique.values()) {
			const start = performance.now()
			const result = convertMetafile(bytes)

			times.push(performance.now() - start)

			if (!result.ok) {
				failures.push(`${name}: ${result.reason}`)
				continue
			}

			bump(formats, result.format)
			items += result.list.itemCount

			if (result.truncated) truncated++
			if (result.unsupported > 0) withUnsupported++
			if (result.list.itemCount === 0) empty++

			const texts = glyphText(result.list)

			for (const text of texts) if (PRIVATE_USE.test(text)) privateUse.push(`${name}: ${JSON.stringify(text)}`)

			if (isMathType(bytes)) {
				mathTypeFiles++
				mathRuns += texts.filter(text => MATH.test(text)).length
			}
		}

		times.sort((a, b) => a - b)

		// The documents holding them, through the bridge: metafile pictures become drawn items.
		const bridged: Record<string, number> = {}

		for (const file of holders) {
			const opened = await openDocxPackage(bytesSource(new Uint8Array(readFileSync(file))))

			if (!opened.ok) continue

			const model = await buildDocxModel(opened.package)
			const bridge = await DocxDrawings.open(model)
			const tally = (list: DrawingList): void => {
				for (const image of list.images) if (image.handling === "metafile") bump(bridged, "left as placeholder")
				for (let item = 0; item < list.itemCount; item++) if (list.kind(item) === ItemKind.TEXT) bump(bridged, "text items")

				bump(bridged, "items", list.itemCount)
			}

			for (const info of model.drawings) {
				const result = await bridge.drawing(info)

				if (result.kind === "drawing") tally(result.list)
			}

			for (const info of model.vml) {
				const result = await bridge.vmlDrawing(info)

				if (result.kind === "drawing") tally(result.list)
			}
		}

		const total = times.reduce((sum, time) => sum + time, 0)

		console.log(
			`metafile corpus: ${parts} parts, ${unique.size} distinct in ${holders.size} documents; ${unique.size - failures.length} converted ` +
				`${JSON.stringify(formats)}, ${failures.length} failed, ${empty} empty, ${truncated} truncated, ${withUnsupported} with records not drawn, ` +
				`${items} items\ntimings: median ${percentile(times, 0.5).toFixed(2)} ms, p95 ${percentile(times, 0.95).toFixed(1)} ms, ` +
				`max ${(times[times.length - 1] ?? 0).toFixed(1)} ms, total ${total.toFixed(0)} ms\n` +
				`MathType: ${mathTypeFiles} pictures, ${mathRuns} text runs with math characters\nbridge ${JSON.stringify(bridged)}`
		)

		expect(failures).toEqual([])
		expect(privateUse).toEqual([])
		// Fewer means lost coverage: the corpus holds about 200 distinct metafiles.
		expect(unique.size).toBeGreaterThanOrEqual(190)
		// The documents holding them reach the bridge: about 5180 drawn items.
		expect(bridged["items"] ?? 0).toBeGreaterThanOrEqual(4900)

		if (mathTypeFiles > 0) expect(mathRuns).toBeGreaterThan(mathTypeFiles / 2)
	})
})
