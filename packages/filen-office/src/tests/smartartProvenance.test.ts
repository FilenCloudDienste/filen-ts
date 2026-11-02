import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { open } from "node:fs/promises"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"
import type { ByteSource } from "../core/opc/io"
import { ZipArchive } from "../core/opc/zipReader"
import { minifyDefinition } from "../core/smartart/gallery/generate"
import { CORPUS_DIR } from "./corpusDir"

// Our SmartArt gallery is our own work: every definition file under assets/smartart carries the authorship header,
// and no run of 64 bytes or more, in a file as written or in the minified text the generated modules ship, appears
// in any layout, style or colours definition part of the OOXML packages in the corpus (which holds the fetched
// SmartArt sets too). The comparison is a rolling hash over every 64-byte window of the gallery, each hit checked
// byte for byte; the corpus packages are read by range, only their central directory and diagram parts. Namespace
// declarations are left out of the comparison on both sides (masked with bytes that differ between the two): their
// URIs are the identifiers ECMA-376 requires every definition to declare, not anyone's writing.

const PACKAGE = join(import.meta.dirname, "..", "..")
const ASSETS = join(PACKAGE, "assets", "smartart")
const RUN = 64
const OOXML = new Set(["pptx", "pptm", "potx", "potm", "ppsx", "ppsm", "docx", "docm", "dotx", "dotm", "xlsx", "xlsm", "xltx", "xltm"])
const DEFINITION_ROOT = /<(?:[A-Za-z_][\w.-]*:)?(?:layoutDef|styleDef|colorsDef)[\s/>]/u
const NAMESPACE_DECLARATION = /xmlns(?::[A-Za-z_][\w.-]*)?\s*=\s*(?:"[^"]*"|'[^']*')/gu
const OURS_MASK = 0x01
const THEIRS_MASK = 0x02
const HEADER = /^\s*(?:<\?xml[^>]*\?>\s*)?<!--[\s\S]*?Filen SmartArt gallery definition[\s\S]*?-->/u

interface Text {
	readonly name: string
	readonly bytes: Uint8Array
}

interface SharedRun {
	readonly text: string
	// Where the run starts in the gallery text and in the other bytes, and how long it is.
	readonly at: number
	readonly otherAt: number
	readonly length: number
}

// Polynomial rolling hash over RUN bytes, mod 2^32.
const BASE = 0x01000193
const TOP = (() => {
	let power = 1

	for (let i = 1; i < RUN; i++) power = Math.imul(power, BASE)

	return power
})()

function windowHash(bytes: Uint8Array, start: number): number {
	let hash = 0

	for (let i = start; i < start + RUN; i++) hash = (Math.imul(hash, BASE) + (bytes[i] as number)) | 0

	return hash
}

function roll(hash: number, out: number, into: number): number {
	return (Math.imul((hash - Math.imul(out, TOP)) | 0, BASE) + into) | 0
}

function equalRun(a: Uint8Array, at: number, b: Uint8Array, bt: number): boolean {
	for (let i = 0; i < RUN; i++) if (a[at + i] !== b[bt + i]) return false

	return true
}

// Every distinct RUN-byte window of the gallery's texts in an open-addressed table (hash, offset into the texts
// laid end to end); windows never span two texts.
class RunIndex {
	private readonly all: Uint8Array
	private readonly starts: number[] = []
	private readonly names: string[] = []
	private readonly hashes: Int32Array
	private readonly offsets: Int32Array
	private readonly mask: number

	constructor(texts: readonly Text[]) {
		let total = 0
		let windows = 0

		for (const text of texts) {
			total += text.bytes.length
			windows += Math.max(0, text.bytes.length - RUN + 1)
		}

		this.all = new Uint8Array(total)

		let size = 1024

		while (size < windows * 2) size *= 2

		this.hashes = new Int32Array(size)
		this.offsets = new Int32Array(size).fill(-1)
		this.mask = size - 1

		let at = 0

		for (const text of texts) {
			this.all.set(text.bytes, at)
			this.starts.push(at)
			this.names.push(text.name)

			if (text.bytes.length >= RUN) {
				let hash = windowHash(this.all, at)

				for (let i = at; ; i++) {
					this.insert(hash, i)

					if (i + RUN >= at + text.bytes.length) break

					hash = roll(hash, this.all[i] as number, this.all[i + RUN] as number)
				}
			}

			at += text.bytes.length
		}
	}

	private slot(hash: number): number {
		return Math.imul(hash, 0x9e3779b1) & this.mask
	}

	private insert(hash: number, offset: number): void {
		for (let slot = this.slot(hash); ; slot = (slot + 1) & this.mask) {
			const held = this.offsets[slot] as number

			if (held < 0) {
				this.hashes[slot] = hash
				this.offsets[slot] = offset

				return
			}

			// The same window again (a repeated element) is already held.
			if (this.hashes[slot] === hash && equalRun(this.all, held, this.all, offset)) return
		}
	}

	private textAt(offset: number): number {
		let low = 0
		let high = this.starts.length - 1

		while (low < high) {
			const mid = (low + high + 1) >> 1

			if ((this.starts[mid] as number) <= offset) low = mid
			else high = mid - 1
		}

		return low
	}

	// The runs of RUN bytes or more that `bytes` shares with the gallery: the first with each gallery text, extended as
	// far as it goes. A window two gallery texts share counts for the first of them.
	shared(bytes: Uint8Array): SharedRun[] {
		const runs = new Map<string, SharedRun>()

		if (bytes.length < RUN) return []

		let hash = windowHash(bytes, 0)

		for (let i = 0; ; i++) {
			for (let slot = this.slot(hash); ; slot = (slot + 1) & this.mask) {
				const held = this.offsets[slot] as number

				if (held < 0) break
				if (this.hashes[slot] !== hash || !equalRun(this.all, held, bytes, i)) continue

				const index = this.textAt(held)
				const name = this.names[index] as string

				if (runs.has(name)) break

				const end = index + 1 < this.starts.length ? (this.starts[index + 1] as number) : this.all.length
				let length = RUN

				while (held + length < end && i + length < bytes.length && this.all[held + length] === bytes[i + length]) length++

				runs.set(name, { text: name, at: held - (this.starts[index] as number), otherAt: i, length })

				break
			}

			if (i + RUN >= bytes.length) return [...runs.values()]

			hash = roll(hash, bytes[i] as number, bytes[i + RUN] as number)
		}
	}
}

function assetFiles(directory: string): string[] {
	const out: string[] = []

	for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
		const path = join(directory, entry.name)

		if (entry.isDirectory()) out.push(...assetFiles(path))
		else if (entry.name.endsWith(".xml")) out.push(path)
	}

	return out
}

// Each definition as written and as the generated modules carry it.
function galleryTexts(): Text[] {
	const encoder = new TextEncoder()

	return assetFiles(ASSETS).flatMap(path => {
		const xml = readFileSync(path, "utf8")
		const name = relative(ASSETS, path)

		return [
			{ name, bytes: maskNamespaces(encoder.encode(xml), OURS_MASK) },
			{ name: `${name} (minified)`, bytes: maskNamespaces(encoder.encode(minifyDefinition(xml)), OURS_MASK) }
		]
	})
}

async function fileSource(path: string): Promise<{ readonly source: ByteSource; readonly close: () => Promise<void> }> {
	const handle = await open(path, "r")
	const { size } = await handle.stat()

	return {
		source: {
			size,
			async read(offset, length) {
				const bytes = new Uint8Array(length)
				const { bytesRead } = await handle.read(bytes, 0, length, offset)

				return bytesRead === length ? bytes : bytes.subarray(0, bytesRead)
			}
		},
		close: () => handle.close()
	}
}

// The bytes with every namespace declaration overwritten by `fill`.
function maskNamespaces(bytes: Uint8Array, fill: number): Uint8Array {
	const text = new TextDecoder("latin1").decode(bytes)
	const out = new Uint8Array(bytes)

	for (const match of text.matchAll(NAMESPACE_DECLARATION)) out.fill(fill, match.index, match.index + match[0].length)

	return out
}

// A part's text as UTF-8 (a UTF-16 part re-encoded).
function utf8(bytes: Uint8Array): Uint8Array {
	const le = bytes[0] === 0xff && bytes[1] === 0xfe
	const be = bytes[0] === 0xfe && bytes[1] === 0xff

	return le || be ? new TextEncoder().encode(new TextDecoder(le ? "utf-16le" : "utf-16be").decode(bytes)) : bytes
}

function corpusPackages(): string[] {
	const manifest = JSON.parse(readFileSync(join(CORPUS_DIR, "manifest.json"), "utf8")) as { files: { path: string }[] }

	return manifest.files.map(file => file.path).filter(path => OOXML.has(path.slice(path.lastIndexOf(".") + 1).toLowerCase()))
}

const corpusPresent = existsSync(join(CORPUS_DIR, "manifest.json"))

describe("SmartArt gallery provenance", () => {
	it("finds a run of 64 shared bytes, and none of 63", () => {
		const encoder = new TextEncoder()
		const ours = encoder.encode(`<dgm:layoutDef>${"ab".repeat(20)}${"0123456789".repeat(7)}</dgm:layoutDef>`)
		const index = new RunIndex([{ name: "ours.xml", bytes: ours }])
		const run = "0123456789".repeat(7).slice(0, RUN)

		expect(index.shared(encoder.encode(`<x>${run}</x>`))).toEqual([{ text: "ours.xml", at: 55, otherAt: 3, length: RUN }])
		expect(index.shared(encoder.encode(`<x>${run.slice(0, RUN - 1)}</x>`))).toEqual([])
		expect(index.shared(encoder.encode(`zz${"ab".repeat(20)}0123456789012345678901234567`))).toEqual([
			{ text: "ours.xml", at: 15, otherAt: 2, length: 68 }
		])
	})

	it("carries the authorship header on every definition file", () => {
		const files = assetFiles(ASSETS)

		expect(files.length).toBeGreaterThan(0)

		for (const path of files) expect(HEADER.test(readFileSync(path, "utf8")), relative(ASSETS, path)).toBe(true)
	})

	it("shares no run of 64 bytes with any layout, style or colours part of the corpus", { timeout: 600_000 }, async context => {
		if (!corpusPresent) {
			context.skip(`the corpus is not fetched (${CORPUS_DIR}): run pnpm run corpus:fetch or set FILEN_OFFICE_CORPUS`)

			return
		}

		const index = new RunIndex(galleryTexts())
		const seen = new Set<string>()
		const found: string[] = []
		let parts = 0

		for (const path of corpusPackages()) {
			const full = join(CORPUS_DIR, path)

			if (!existsSync(full)) continue

			const file = await fileSource(full)

			try {
				// Encrypted and damaged packages hold no readable definition part.
				const zip = await ZipArchive.open(file.source).catch(() => undefined)

				for (const entry of zip?.entries ?? []) {
					if (!/diagram/iu.test(entry.name) || !entry.name.toLowerCase().endsWith(".xml") || zip === undefined) continue

					const bytes = utf8(await zip.read(entry))
					const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048))

					if (!DEFINITION_ROOT.test(head)) continue

					const digest = createHash("sha1").update(bytes).digest("hex")

					if (seen.has(digest)) continue

					seen.add(digest)
					parts++

					for (const run of index.shared(maskNamespaces(bytes, THEIRS_MASK)))
						found.push(`${path}!${entry.name} shares ${String(run.length)} bytes with ${run.text} at ${String(run.at)}`)
				}
			} finally {
				await file.close()
			}
		}

		expect(parts, "definition parts read from the corpus").toBeGreaterThan(0)
		expect(found).toEqual([])
	})
})
