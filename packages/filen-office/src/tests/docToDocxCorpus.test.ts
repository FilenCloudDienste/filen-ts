import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { CfbFile, cfbBytes, type CfbWriteEntry } from "@filen/office/core/cfb"
import { bytesSource } from "@filen/office/core/opc"
import { DocError, docText, readDoc, type DocErrorCode } from "@filen/office/core/doc"
import { parseXml } from "@filen/office/core/xml"
import { convertDocToDocx, docxPackage } from "../core/doc/toDocx/index"
import { CORPUS_DIR } from "./corpusDir"
import { docxBodyText, reopen } from "./docToDocxFixtures"
import { OpenXmlSdk, openXmlSdkMissing } from "./oracles/openXmlSdk"
import { budget } from "./timing"

// The corpus .doc/.dot files converted to WordprocessingML: each converts or is refused with the reader's typed
// reason; the package reads back through the docx reader with the body text of the Word binary document (list
// labels and note numbers are generated, so left out; hidden and deleted text kept); conversion time stays linear
// in the file size. With FILEN_OFFICE_OOXML_VALIDATOR set, the Open XML SDK finds no error in any package.

const FAMILIES = ["doc", "dot"]
const fetched = existsSync(join(CORPUS_DIR, "doc"))

function corpusFiles(): string[] {
	if (!fetched) return []

	return FAMILIES.flatMap(family =>
		existsSync(join(CORPUS_DIR, family)) ? readdirSync(join(CORPUS_DIR, family)).map(name => `${family}/${name}`) : []
	).sort()
}

const REFUSED: Readonly<Record<string, DocErrorCode>> = {
	"dot/frictionless__package.dot": "notWordBinary",
	"dot/tika__testGRAPHVIZdc.dot": "notWordBinary",
	"doc/govuk__Audit_20Committee_20minutes_208_20June_202012.doc": "notWordBinary",
	"doc/lo__tdf150197_anlv2ListFormat.doc": "legacyVersion",
	"doc/lo__tdf59896.doc": "legacyVersion",
	"doc/poi__57843.doc": "legacyVersion",
	"doc/poi__Bug60942b.doc": "legacyVersion",
	"doc/poi__PasswordProtected.doc": "encrypted",
	"doc/poi__password_password_cryptoapi.doc": "encrypted",
	"doc/poi__password_tika_binaryrc4.doc": "encrypted"
}

function load(path: string): Uint8Array {
	const bytes = readFileSync(path)

	return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

const words = (text: string): string[] =>
	text
		.replace(/\u00a0/gu, " ")
		.split(/\s+/u)
		.filter(word => word !== "")

describe.skipIf(!fetched)("Word binary corpus to WordprocessingML", () => {
	it("converts every readable file with its body text and refuses the rest with their typed reason", { timeout: 300_000 }, async () => {
		const refused: Record<string, string> = {}
		const differing: string[] = []
		const slow: string[] = []

		for (const path of corpusFiles()) {
			const bytes = load(join(CORPUS_DIR, path))
			let result

			const started = performance.now()

			try {
				result = await convertDocToDocx(bytesSource(bytes))
			} catch (error) {
				if (!(error instanceof DocError)) throw error

				refused[path] = error.code
				continue
			}

			const ms = performance.now() - started

			// Generous for a loaded machine: a few tens of milliseconds per megabyte are measured.
			if (ms > budget(500 + (600 * bytes.length) / 1e6)) slow.push(`${path}: ${ms.toFixed(0)} ms`)

			const ours = words(docText(await readDoc(bytesSource(bytes)), { labels: false, framed: true, hidden: true }))
			const back = words(docxBodyText(await reopen(result)))

			if (ours.length !== back.length || ours.some((word, k) => word !== back[k])) differing.push(path)
		}

		expect(refused).toEqual(REFUSED)
		expect(differing).toEqual([])
		expect(slow).toEqual([])
	})

	const missing = openXmlSdkMissing()

	it.skipIf(missing !== undefined)("writes packages the Open XML SDK finds no error in", { timeout: 1_800_000 }, async () => {
		const sdk = new OpenXmlSdk()
		const scratch = mkdtempSync(join(tmpdir(), "filen-office-doc-docx-"))
		const failures: string[] = []

		try {
			for (const path of corpusFiles()) {
				if (REFUSED[path] !== undefined) continue

				const result = await convertDocToDocx(bytesSource(load(join(CORPUS_DIR, path))))
				const file = join(scratch, "converted.docx")

				writeFileSync(file, await docxPackage(result.parts))

				const validated = await sdk.validate(file)

				if (validated.fatal !== undefined) failures.push(`${path}: ${validated.fatal}`)

				for (const error of validated.errors)
					failures.push(`${path}: ${error.id} ${error.description} (${error.part ?? ""} ${error.path ?? ""})`)
			}
		} finally {
			await sdk.close()
			rmSync(scratch, { recursive: true, force: true })
		}

		expect(failures).toEqual([])
	})
})

function random(seed: number): () => number {
	let state = seed >>> 0

	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0

		return state / 0x100000000
	}
}

// Overwrites bytes anywhere in the WordDocument, Table and Data streams (pictures, the drawing group and field data
// included), the compound file rebuilt around them. FILEN_OFFICE_DOC_FUZZ (rounds) and FILEN_OFFICE_DOC_FUZZ_SEED
// replace the fixed count and seed, as in docFuzz.test.ts.
function mutate(entries: readonly { readonly path: string; readonly bytes: Uint8Array }[], next: () => number): CfbWriteEntry[] {
	return entries.map(entry => {
		const bytes = entry.bytes.slice()
		const count = 1 + Math.floor(next() * 16)

		for (let k = 0; k < count && bytes.length > 0; k++) {
			const span = next() < 0.4 ? Math.min(bytes.length, 1024) : bytes.length
			const at = Math.floor(next() * span)
			const kind = next()

			bytes[at] =
				kind < 0.4
					? Math.floor(next() * 256)
					: kind < 0.7
						? 0xff
						: kind < 0.85
							? 0
							: (bytes[at] ?? 0) ^ (1 << Math.floor(next() * 8))
		}

		return { path: [entry.path], bytes }
	})
}

describe.skipIf(!fetched)("mutated Word binary documents to WordprocessingML", () => {
	it("convert to well-formed packages or refuse with a typed error", { timeout: 600_000 }, async () => {
		const sources: { name: string; entries: { path: string; bytes: Uint8Array }[] }[] = []

		for (const path of corpusFiles()) {
			const bytes = load(join(CORPUS_DIR, path))

			if (REFUSED[path] !== undefined || bytes.length > 600_000) continue

			const cfb = await CfbFile.open(bytesSource(bytes))
			const entries: { path: string; bytes: Uint8Array }[] = []

			for (const name of ["WordDocument", "0Table", "1Table", "Data"]) {
				if (cfb.entry([name])?.kind === "stream") entries.push({ path: name, bytes: await cfb.read(name) })
			}

			sources.push({ name: path, entries })
		}

		const seed = Number(process.env["FILEN_OFFICE_DOC_FUZZ_SEED"] || "23")
		const rounds = Number(process.env["FILEN_OFFICE_DOC_FUZZ"] || "600")
		const next = random(seed)
		const untyped: string[] = []
		let slowest = 0

		for (let k = 0; k < rounds; k++) {
			const source = sources[Math.floor(next() * sources.length)]

			if (source === undefined) continue

			const bytes = await cfbBytes(mutate(source.entries, next))
			const started = performance.now()

			try {
				const result = await convertDocToDocx(bytesSource(bytes))

				for (const [name, part] of result.parts) if (name.endsWith(".xml") || name.endsWith(".rels")) parseXml(part)
			} catch (error) {
				if (!(error instanceof DocError))
					untyped.push(
						`${source.name} #${k} (seed ${seed}): ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
					)
			}

			slowest = Math.max(slowest, performance.now() - started)
		}

		expect(untyped).toEqual([])
		expect(slowest, `seed ${seed}`).toBeLessThan(budget(3000))
	})
})
