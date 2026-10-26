import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { openPptFile } from "../core/ppt/document"
import type { PptDecryption } from "../core/ppt/decrypt"
import { recordAt } from "../core/ppt/records"
import { pptToPptx } from "../core/ppt/toPptx"
import type { CorpusManifest } from "../scripts/corpusManifest"
import { CORPUS_DIR } from "./corpusDir"
import { msoffcryptoPython } from "./encryption/oracles/msoffcrypto"
import { CORPUS_PASSWORDS } from "./oracles/presentation/corpus"

// Every encrypted .ppt of the corpus, decrypted with its published password: each persist object (8 + recLen bytes
// at its offset, [MS-PPT] §2.3.7) byte for byte against msoffcrypto-tool's decrypted PowerPoint Document stream; a
// wrong password refused. msoffcrypto is opt-in through FILEN_OFFICE_MSOFFCRYPTO; the corpus is needed.

const python = msoffcryptoPython()
const SCRIPT = join(import.meta.dirname, "pptDecryptOracle.py")
const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "corpus", "manifest.json"), "utf8")) as CorpusManifest
const ENCRYPTED = manifest.files
	.filter(file => /^ppt\//u.test(file.path))
	.map(file => ({ path: file.path, password: file.password ?? CORPUS_PASSWORDS[file.path.slice(4)] }))
	.filter((file): file is { path: string; password: string } => file.password !== undefined && existsSync(join(CORPUS_DIR, file.path)))
const scratch = python === undefined ? "" : mkdtempSync(join(tmpdir(), "ppt-decrypt-oracle-"))

afterAll(() => {
	if (scratch !== "") rmSync(scratch, { recursive: true, force: true })
})

function decryption(password: string): PptDecryption {
	return { password, sha1: data => Promise.resolve(new Uint8Array(createHash("sha1").update(data).digest())) }
}

function oracle(file: string, password: string): Uint8Array {
	const out = join(scratch, `${Math.random().toString(36).slice(2)}.stream`)
	const result = spawnSync(python ?? "", ["-I", SCRIPT, file, password, out], { encoding: "utf8", timeout: 120_000 })
	const answer = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") as { ok?: boolean; error?: string }

	if (answer.ok !== true) throw new Error(`msoffcrypto refused ${file}: ${answer.error ?? String(result.status)}`)

	return new Uint8Array(readFileSync(out))
}

describe.skipIf(ENCRYPTED.length === 0)("encrypted ppt corpus", () => {
	it("has the five fixtures with published passwords and more", () => {
		expect(ENCRYPTED.length).toBeGreaterThanOrEqual(7)
	})

	// msoffcrypto-tool 6.0 decrypts each persist object up to the offset of the next object in directory order, not
	// over its own 8 + recLen (its source marks this "TODO"), so where offsets do not ascend with persist ids a later
	// object's range overwrites an earlier one's plaintext. Those objects are checked as records instead.
	function comparable(entries: readonly (readonly [number, number])[], session: number, stream: Uint8Array): Set<number> {
		const ranges = entries.map(([id, offset], index) => {
			const next = entries[index + 1]?.[1] ?? stream.length

			return { id, start: offset, end: next > offset ? next : stream.length }
		})
		const out = new Set<number>()

		ranges.forEach((range, index) => {
			if (range.id === session) return

			const own = recordAt(stream, range.start).end
			const covered = range.end >= own
			const clobbered = ranges.slice(index + 1).some(later => later.id !== session && later.start < own && later.end > range.start)

			if (covered && !clobbered) out.add(range.id)
		})

		return out
	}

	it.skipIf(python === undefined)("decrypts every persist object as msoffcrypto does", { timeout: 120_000 }, async ({ task }) => {
		let objects = 0
		let structural = 0

		for (const file of ENCRYPTED) {
			const path = join(CORPUS_DIR, file.path)
			const opened = await openPptFile(bytesSource(new Uint8Array(readFileSync(path))), { decryption: decryption(file.password) })
			const theirs = oracle(path, file.password)
			const session = opened.directory.current.encryptSessionPersistIdRef

			expect(opened.encrypted, file.path).toBe(true)
			expect(theirs.length, file.path).toBe(opened.stream.length)

			const equal = comparable([...opened.directory.offsets], session, opened.stream)

			for (const [id, offset] of opened.directory.offsets) {
				if (id === session) continue

				const record = recordAt(opened.stream, offset)

				if (equal.has(id)) {
					expect(opened.stream.subarray(offset, record.end), `${file.path} persist ${String(id)}`).toEqual(
						theirs.subarray(offset, record.end)
					)
					objects++
				} else {
					// A container record (recVer 0xF) of a persist object's type whose length stays inside the stream.
					expect([0x03e8, 0x03ee, 0x03f0, 0x03f8, 0x0fc9, 0x1011, 0x040a], `${file.path} persist ${String(id)}`).toContain(
						record.type
					)
					structural++
				}
			}
		}

		Object.assign(task.meta, { persistObjects: { byteEqual: objects, structural } })
		expect(objects).toBeGreaterThanOrEqual(30)
	})

	it("refuses a wrong password and asks for a missing one", { timeout: 60_000 }, async () => {
		for (const file of ENCRYPTED) {
			const bytes = new Uint8Array(readFileSync(join(CORPUS_DIR, file.path)))

			expect(await pptToPptx(bytesSource(bytes), { decryption: decryption(`${file.password}x`) }), file.path).toMatchObject({
				kind: "refused",
				reason: "wrongPassword"
			})
			expect(await pptToPptx(bytesSource(bytes)), file.path).toMatchObject({ kind: "refused", reason: "needsPassword" })
		}
	})

	it("decrypts the encrypted Pictures stream into the PNG it holds", async () => {
		const file = ENCRYPTED.find(entry => entry.path.endsWith("ppt_with_png_encrypted.ppt"))

		if (file === undefined) return

		const converted = await pptToPptx(bytesSource(new Uint8Array(readFileSync(join(CORPUS_DIR, file.path)))), {
			decryption: decryption(file.password)
		})

		if (converted.kind === "refused") throw new Error(converted.reason)

		const media = [...converted.pptx.entries()].filter(entry => entry.name.startsWith("ppt/media/"))

		expect(media.length).toBeGreaterThan(0)

		for (const entry of media) {
			const bytes = await converted.pptx.read(entry.name)

			expect([...bytes.subarray(0, 8)], entry.name).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
		}
	})

	it("converts every encrypted deck with its password", { timeout: 60_000 }, async () => {
		for (const file of ENCRYPTED) {
			const bytes = new Uint8Array(readFileSync(join(CORPUS_DIR, file.path)))
			const converted = await pptToPptx(bytesSource(bytes), { decryption: decryption(file.password) })

			if (converted.kind === "refused") throw new Error(`${file.path}: ${converted.reason} ${converted.detail ?? ""}`)

			expect(converted.encrypted, file.path).toBe(true)
			expect(converted.slides, file.path).toBeGreaterThan(0)
		}
	})
})
