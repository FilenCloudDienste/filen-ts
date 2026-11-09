import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { CONTAINERS, FAMILIES, familyOf, unavailableAllowed, type CorpusFamily, type CorpusManifest } from "../scripts/corpusManifest"
import { CORPUS_DIR } from "./corpusDir"

// Every corpus family, with an engine or not: the fetched files are the bytes the manifest pins and the container
// their catalogue entry says. The engine sweeps (*Corpus.test.ts) go further for their own family.

const COMMITTED = join(import.meta.dirname, "..", "..", "corpus")
const manifest = JSON.parse(readFileSync(join(COMMITTED, "manifest.json"), "utf8")) as CorpusManifest
const catalogue = JSON.parse(readFileSync(join(COMMITTED, "catalogue.json"), "utf8")) as {
	files: { path: string; container?: string; producer?: string }[]
}
const containers = new Map(catalogue.files.map(entry => [entry.path, entry.container]))
const byFamily = Map.groupBy(manifest.files, file => familyOf(file.path))
// A directory `pnpm run corpus:fetch` populated: it writes manifest.json (the legacy location has MANIFEST.json).
const fetched = existsSync(CORPUS_DIR) && readdirSync(CORPUS_DIR).includes("manifest.json")

type Container = "zip" | "cfb" | "rtf" | "other"

function sniff(bytes: Uint8Array): Container {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

	if (bytes.length >= 4 && (view.getUint32(0) === 0x504b0304 || view.getUint32(0) === 0x504b0506)) return "zip"
	if (bytes.length >= 8 && view.getUint32(0) === 0xd0cf11e0 && view.getUint32(4) === 0xa1b11ae1) return "cfb"
	if (/^\s*\{\\rtf/.test(new TextDecoder("latin1").decode(bytes.subarray(0, 16)))) return "rtf"

	return "other"
}

function expected(path: string, family: CorpusFamily): Container {
	const container = containers.get(path) ?? CONTAINERS[family]

	return container === "zip" || container === "cfb" || container === "rtf" ? container : "other"
}

describe("corpus manifest", () => {
	it("gives every file a family, a catalogue entry and an attributed https source", () => {
		const sources = new Map(manifest.sources.map(source => [source.id, source]))
		const problems: string[] = []

		for (const file of manifest.files) {
			const source = sources.get(file.source)

			if (familyOf(file.path) === undefined) problems.push(`${file.path}: no family`)
			if (!containers.has(file.path)) problems.push(`${file.path}: no catalogue entry`)
			if (source === undefined || source.licence !== file.licence) problems.push(`${file.path}: source or licence unknown`)
			if (!file.url.startsWith("https://")) problems.push(`${file.path}: not https`)
			if (!/^[0-9a-f]{64}$/.test(file.sha256) || file.size <= 0) problems.push(`${file.path}: no SHA-256 or size`)
		}

		expect(problems).toEqual([])
		expect(catalogue.files.length).toBe(manifest.files.length)
	})

	// A package without docProps/app.xml says nothing of its producer; LibreOffice fixtures are not Google exports.
	it("names no producer it guessed from a missing app.xml", () => {
		expect(catalogue.files.filter(entry => entry.producer === "google-docs?").map(entry => entry.path)).toEqual([])
	})
})

describe.skipIf(!fetched)("corpus files fetched for every family", () => {
	for (const family of Object.keys(FAMILIES) as CorpusFamily[]) {
		const files = byFamily.get(family) ?? []
		const present = files.filter(file => existsSync(join(CORPUS_DIR, file.path)))

		// `corpus:fetch --family` may have fetched other families only.
		it.skipIf(present.length === 0)(`${family}: every file is the pinned bytes in the expected container`, { timeout: 120_000 }, () => {
			const problems: string[] = []
			const seen = new Map<Container, number>()
			let bytes = 0

			for (const file of present) {
				const data = readFileSync(join(CORPUS_DIR, file.path))
				const container = sniff(data)

				bytes += data.length
				seen.set(container, (seen.get(container) ?? 0) + 1)

				if (data.length !== file.size) problems.push(`${file.path}: ${data.length} bytes instead of ${file.size}`)
				else if (createHash("sha256").update(data).digest("hex") !== file.sha256) problems.push(`${file.path}: SHA-256 differs`)
				else if (container !== expected(file.path, family))
					problems.push(`${file.path}: ${container}, catalogued as ${expected(file.path, family)}`)
			}

			console.log(
				`corpus ${family}: ${present.length}/${files.length} files, ${(bytes / 1e6).toFixed(1)} MB, ` +
					[...seen].map(([container, count]) => `${container} ${count}`).join(", ")
			)

			expect(problems).toEqual([])
			// Sources can vanish; corpus:fetch tolerates as many.
			expect(files.length - present.length).toBeLessThanOrEqual(unavailableAllowed(files.length))
		})
	}
})
