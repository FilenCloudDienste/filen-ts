import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bytesSource, OpcPackage } from "@filen/office/core/opc"
import { parseXml } from "@filen/office/core/xml"
import { DocxEditorSession } from "@filen/office/core/docx/edit"
import { DocxSaveError, saveDocx } from "@filen/office/core/docx/write"
import { CORPUS_DIR as CORPUS } from "./corpusDir"
import { openBytes } from "./docxEditFixtures"
import { runEditScript } from "./docxWriteFixtures"
import { scriptOps } from "./fuzz/ops/index"
import { sameBytes } from "../core/docx/write/bytes"

// The licensed real-world corpus is kept out of the repository (pnpm run corpus:fetch); this sweep runs only where it exists.
const EXTENSIONS = ["docx", "docm", "dotx", "dotm"]

function corpusFiles(): string[] {
	const files: string[] = []

	for (const extension of EXTENSIONS) {
		const directory = join(CORPUS, extension)

		if (!existsSync(directory)) continue

		for (const name of readdirSync(directory).sort()) files.push(join(directory, name))
	}

	return files
}

// Body children of a document part by content hash.
function blockHashes(bytes: Uint8Array): Map<number, number> {
	const document = parseXml(bytes)
	const out = new Map<number, number>()
	const root = document.documentElement()
	const body = document.firstChildElement(root)

	for (let child = document.firstChildElement(body); child >= 0; child = document.nextSiblingElement(child)) {
		let hash = 0x811c9dc5

		for (let i = document.start(child); i < document.end(child); i++) hash = Math.imul(hash ^ (bytes[i] ?? 0), 0x01000193)

		out.set(hash, (out.get(hash) ?? 0) + 1)
	}

	return out
}

// Top-level blocks of `after` whose bytes are none of `before`'s.
function newBlocks(before: Uint8Array, after: Uint8Array): number {
	const source = blockHashes(before)
	let count = 0

	for (const [hash, times] of blockHashes(after)) count += Math.max(0, times - (source.get(hash) ?? 0))

	return count
}

describe.skipIf(!existsSync(CORPUS))("docx writer over the real-world corpus", () => {
	it("writes every unedited document back byte for byte", { timeout: 900_000 }, async () => {
		const failures: string[] = []
		let files = 0
		let identical = 0

		for (const file of corpusFiles()) {
			const name = file.slice(CORPUS.length + 1)
			const bytes = new Uint8Array(readFileSync(file))
			let opened

			try {
				opened = await openBytes(bytes)
			} catch {
				continue
			}

			if (opened.model.body === undefined || opened.context.gate.length > 0) continue

			files++

			try {
				const session = new DocxEditorSession(opened.context, { proof: null })
				const result = await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: [session] })

				if (result.changedParts.length === 0 && result.bytes !== undefined && sameBytes(result.bytes, bytes)) identical++
				else failures.push(`${name}: ${result.changedParts.join(", ") || "bytes differ"}`)
			} catch (error) {
				failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
			}
		}

		console.log(`unedited: ${identical}/${files} byte-identical`)
		expect(failures).toEqual([])
	})

	it("saves the scripted edits of every document through gate 2", { timeout: 1_800_000 }, async () => {
		const failures: string[] = []
		const reasons: Record<string, number> = {}
		const edits: Record<string, number> = {}
		let files = 0
		let saved = 0
		let slowest = { name: "", ms: 0 }

		for (const file of corpusFiles()) {
			const name = file.slice(CORPUS.length + 1)
			const bytes = new Uint8Array(readFileSync(file))
			let opened

			try {
				opened = await openBytes(bytes)
			} catch {
				continue
			}

			if (opened.model.body === undefined || opened.context.gate.length > 0) continue

			files++

			const start = performance.now()

			try {
				const script = runEditScript(opened)

				for (const edit of script.done) edits[edit] = (edits[edit] ?? 0) + 1

				const result = await saveDocx({ pkg: opened.pkg, context: opened.context, sessions: script.sessions })
				if (result.bytes === undefined) throw new Error("No bytes")

				const written = await OpcPackage.open(bytesSource(result.bytes))
				const types = await written.contentTypes()
				const allowed = new Set([
					"word/document.xml",
					"word/numbering.xml",
					"word/styles.xml",
					"word/_rels/document.xml.rels",
					"[Content_Types].xml"
				])
				const writes = new Set(scriptOps().flatMap(op => (script.done.includes(op.name) ? (op.writes ?? []) : [])))
				const declared = (part: string): boolean => {
					const type = types.typeOf(part) ?? ""

					return writes.has(type) || writes.has(type.replace(/^.*[./]([\w-]+)\+xml$/, "$1"))
				}
				const unexpected = result.changedParts.filter(
					part => !allowed.has(part) && part !== opened.pkg.mainPart && !part.endsWith(".rels") && !declared(part)
				)

				if (unexpected.length > 0) failures.push(`${name}: unexpected changed parts ${unexpected.join(", ")}`)
				if (written.zip.entries.length < opened.pkg.opc.zip.entries.length) failures.push(`${name}: entries lost`)

				// Only the edited blocks are new bytes: every other top-level block is one of the source's.
				const changedBlocks = newBlocks(await opened.pkg.opc.read(opened.pkg.mainPart), await written.read(opened.pkg.mainPart))

				if (changedBlocks > script.done.length + 1)
					failures.push(`${name}: ${changedBlocks} blocks changed for ${script.done.length} edits`)

				saved++
			} catch (error) {
				const reason = error instanceof DocxSaveError ? error.reason : "exception"

				reasons[reason] = (reasons[reason] ?? 0) + 1
				failures.push(`${name}: ${reason}: ${error instanceof Error ? error.message.slice(0, 600) : String(error)}`)
			}

			const ms = performance.now() - start

			if (ms > slowest.ms) slowest = { name, ms }
		}

		console.log(
			`edit suite: ${saved}/${files} saved; edits ${JSON.stringify(edits)}; failures ${JSON.stringify(reasons)}; slowest ${slowest.name} ${slowest.ms.toFixed(0)} ms`
		)
		expect(failures).toEqual([])
	})
})
