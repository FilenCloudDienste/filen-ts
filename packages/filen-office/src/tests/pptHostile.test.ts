import { webcrypto } from "node:crypto"
import { deflateSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import { Rc4 } from "../core/crypto/legacy"
import { cryptoApiBlockKey } from "../core/doc/decrypt"
import { blipFile, blipSize } from "../core/doc/toDocx/officeArt"
import { bytesSource } from "../core/opc/io"
import { decryptPersistObjects } from "../core/ppt/decrypt"
import { readPersistDirectory, type PersistDirectory } from "../core/ppt/persist"
import { DEFAULT_PPT_BUDGETS } from "../core/ppt/records"
import { pptToPptx } from "../core/ppt/toPptx"
import { openPptxPackage } from "../core/pptx/package"
import { PresentationError } from "../core/presentation/model"
import { servePresentation } from "../dom/presentation/engine"
import type { OpenInfo, PresentationOpenOptions } from "../dom/presentation/protocol"
import { cryptoApiKeys, encryptionHeader } from "./docDecryptFixtures"
import { loopback, LoopbackSession } from "./fixtures/presentation/loopback"
import { buildPpt, concat, record, type FixtureShape } from "./pptFixtures"
import { buildPptx, sp, tree } from "./pptxFixtures"
import { budget, cpuMs } from "./timing"

// Hostile PowerPoint 97–2003 input bounded in CPU and memory: the persist directory, the BLIP store, decryption and
// the style runs; and a ppt deck only shown, never edited or saved in place.

function u32(value: number): Uint8Array {
	return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff)
}

function u16(value: number): Uint8Array {
	return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff)
}

// A PowerPoint Document stream of `edits` UserEditAtoms, edit k naming directories[k] (oldest first) at the stream's
// start, the newest edit last.
function editChain(
	directories: readonly (readonly (readonly [number, number])[])[],
	uses: readonly number[]
): { stream: Uint8Array; current: number } {
	const atoms: Uint8Array[] = []
	const offsets: number[] = []
	let at = 0

	for (const entries of directories) {
		offsets.push(at)

		const atom = record(0x1772, concat(...entries.map(([first, offset]) => concat(u32(((1 << 20) | first) >>> 0), u32(offset)))))

		atoms.push(atom)
		at += atom.length
	}

	const editSize = 8 + 0x1c

	uses.forEach((directory, k) => {
		const data = concat(new Uint8Array(8), u32(k === 0 ? 0 : at - editSize), u32(offsets[directory] ?? 0), new Uint8Array(0x1c - 16))

		atoms.push(record(0x0ff5, data))
		at += editSize
	})

	return { stream: concat(...atoms), current: at - editSize }
}

function bigDirectory(ids: number): Uint8Array {
	const words: number[] = []

	for (let first = 1; first <= ids; first += 4095) {
		const count = Math.min(4095, ids - first + 1)

		words.push(((count << 20) | first) >>> 0)

		for (let k = 0; k < count; k++) words.push(k)
	}

	return record(0x1772, concat(...words.map(u32)))
}

function sameDirectoryChain(ids: number, edits: number): { stream: Uint8Array; current: number } {
	const directory = bigDirectory(ids)
	const editSize = 8 + 0x1c
	const parts: Uint8Array[] = [directory]

	for (let k = 0; k < edits; k++) {
		parts.push(
			record(0x0ff5, concat(new Uint8Array(8), u32(k === 0 ? 0 : directory.length + (k - 1) * editSize), u32(0), new Uint8Array(12)))
		)
	}

	return { stream: concat(...parts), current: directory.length + (edits - 1) * editSize }
}

describe("ppt persist directory", () => {
	it("reads a directory once however many edits name it", () => {
		const { stream, current } = sameDirectoryChain(50_000, 10_000)
		const start = cpuMs()
		const directory = readPersistDirectory(stream, { headerToken: 0, offsetToCurrentEdit: current })

		expect(cpuMs() - start).toBeLessThan(budget(500))
		expect(directory.offsets.size).toBe(50_000)
		expect(directory.edits).toHaveLength(10_000)
	})

	it("lets the newest edit naming a directory win over an edit between its uses", () => {
		// Edit 0 and edit 2 name directory A (id 1 → 100), edit 1 names B (id 1 → 200, id 2 → 300).
		const { stream, current } = editChain(
			[
				[[1, 100]],
				[
					[1, 200],
					[2, 300]
				]
			],
			[0, 1, 0]
		)
		const directory = readPersistDirectory(stream, { headerToken: 0, offsetToCurrentEdit: current })

		expect(directory.offsets.get(1)).toBe(100)
		expect(directory.offsets.get(2)).toBe(300)
	})

	it("counts every entry the chain reads against the persist id budget, not distinct ids", () => {
		// Two directories of the same 600 ids: 1,200 entries over a budget of 1,000.
		const { stream, current } = editChain(
			[Array.from({ length: 600 }, (_, k) => [k + 1, k] as const), Array.from({ length: 600 }, (_, k) => [k + 1, k + 1] as const)],
			[0, 1]
		)

		expect(() =>
			readPersistDirectory(stream, { headerToken: 0, offsetToCurrentEdit: current }, { ...DEFAULT_PPT_BUDGETS, persistIds: 1000 })
		).toThrow(expect.objectContaining({ reason: "tooLarge" }) as PresentationError)
	})
})

// An EMF BLIP (MS-ODRAW §2.2.24): rgbUid1, OfficeArtMetafileHeader (cbSize, rcBounds, ptSize, cbSave, deflate), data.
function emfBlip(declared: number, inflated: number): Uint8Array {
	const z = new Uint8Array(deflateSync(new Uint8Array(inflated).fill(1)))
	const header = concat(u32(declared), new Uint8Array(16), new Uint8Array(8), u32(z.length), Uint8Array.of(0, 0xfe))

	return record(0xf01a, concat(new Uint8Array(16), header, z), 0x3d4, 0)
}

// An uncompressed EMF BLIP of `size` bytes of data.
function plainEmfBlip(size: number): Uint8Array {
	const header = concat(u32(size), new Uint8Array(16), new Uint8Array(8), u32(size), Uint8Array.of(0xfe, 0xfe))

	return record(0xf01a, concat(new Uint8Array(16), header, new Uint8Array(size).fill(2)), 0x3d4, 0)
}

// An FBSE (§2.2.32) of an EMF in the Pictures stream at `offset`.
function delayedFbse(offset: number, size: number): Uint8Array {
	return record(
		0xf007,
		concat(Uint8Array.of(2, 2), new Uint8Array(16), u16(0xff), u32(size), u32(1), u32(offset), new Uint8Array(4)),
		2,
		2
	)
}

function arrayBuffersMiB(): number {
	return process.memoryUsage().arrayBuffers / 1048576
}

describe("ppt BLIP store", () => {
	it("holds no metafile until it is read, and inflates one to its real size, not the one it declares", async () => {
		const store = Array.from({ length: 40 }, () => emfBlip(60 * 1024 * 1024, 1024))
		const pictureShape: FixtureShape = { anchor: [0, 0, 100, 100], picture: true }
		const built = await buildPpt({ slides: [{ shapes: [pictureShape] }], store })
		const before = arrayBuffersMiB()
		const result = await pptToPptx(bytesSource(built.bytes))

		if (result.kind !== "converted") throw new Error(JSON.stringify(result))

		expect(arrayBuffersMiB() - before).toBeLessThan(32)

		const part = [...result.pptx.entries()].map(entry => entry.name).find(name => name.startsWith("ppt/media/"))

		expect(part).toBeDefined()
		expect(result.pptx.entry(part ?? "")?.uncompressedSize).toBeLessThan(1024 * 1024)

		const bytes = await result.pptx.read(part ?? "")

		expect(bytes.length).toBe(1024)
		expect(bytes.buffer.byteLength).toBe(1024)
	})

	it("reads a picture many store entries point at only when a part is read", async () => {
		const emf = plainEmfBlip(8 * 1024 * 1024)
		const store = Array.from({ length: 50 }, () => delayedFbse(0, emf.length))
		const shapes: FixtureShape[] = Array.from({ length: 50 }, (_, k) => ({ anchor: [0, 0, 100, 100], properties: [[0x4104, k + 1]] }))
		const built = await buildPpt({ slides: [{ shapes }], store, picturesStream: emf })
		const before = arrayBuffersMiB()
		const result = await pptToPptx(bytesSource(built.bytes))

		if (result.kind !== "converted") throw new Error(JSON.stringify(result))

		expect(arrayBuffersMiB() - before).toBeLessThan(16)
		expect([...result.pptx.entries()].filter(entry => entry.name.startsWith("ppt/media/"))).toHaveLength(50)
	})

	it("refuses a deck whose shown pictures declare more than the package's non-media total", async () => {
		const emf = plainEmfBlip(64 * 1024 * 1024 - 64)
		const store = Array.from({ length: 9 }, () => delayedFbse(0, emf.length))
		const shapes: FixtureShape[] = Array.from({ length: 9 }, (_, k) => ({
			anchor: [0, 0, 100, 100],
			properties: [[0x4104, k + 1]]
		}))
		const built = await buildPpt({ slides: [{ shapes }], store, picturesStream: emf })
		const result = await pptToPptx(bytesSource(built.bytes))

		if (result.kind !== "converted") throw new Error(JSON.stringify(result))

		expect(await openPptxPackage(result.pptx)).toMatchObject({ kind: "refused", reason: "tooLarge" })
	})

	it("gives a shared metafile reader a picture of its own length, bounded by what its deflate stream holds", () => {
		const data = emfBlip(60 * 1024 * 1024, 1024)
		const recordOf = { type: 0xf01a, instance: 0x3d4, version: 0, start: 8, end: data.length }
		const blip = blipFile(data, recordOf)

		expect(blip?.bytes.length).toBe(1024)
		expect(blip?.bytes.buffer.byteLength).toBe(1024)
		expect(blipSize(data, recordOf)).toBeLessThan(data.length * 1033)
	})
})

describe("ppt decryption", () => {
	it("refuses persist objects that overlap into a key stream over the stream many times", async () => {
		const ids = 400
		const length = 2 * 1024 * 1024
		const stream = new Uint8Array(length)
		const keyOf = cryptoApiKeys("pw", 128)
		const offsets = new Map<number, number>()

		for (let id = 1; id <= ids; id++) {
			const at = 8 * id
			const head = concat(new Uint8Array(4), u32(length - at - 8))
			const out = new Uint8Array(8)

			new Rc4(keyOf(id)).apply(head, out, 0, 0, 8)
			stream.set(out, at)
			offsets.set(id, at)
		}

		const decryption = {
			password: "pw",
			sha1: async (data: Uint8Array) => new Uint8Array(await webcrypto.subtle.digest("SHA-1", data))
		}
		const header = encryptionHeader({ scheme: "cryptoApiRc4", password: "pw", keySize: 128 })
		const key = { key: await cryptoApiBlockKey(header, decryption), session: 0 }
		const directory = { offsets, edits: [], current: {} } as unknown as PersistDirectory
		const start = cpuMs()

		await expect(decryptPersistObjects(stream, directory, key)).rejects.toMatchObject({ reason: "tooLarge" })
		expect(cpuMs() - start).toBeLessThan(budget(300))
	})

	it("refuses to decrypt with a key once it is wiped", async () => {
		const decryption = {
			password: "pw",
			sha1: async (data: Uint8Array) => new Uint8Array(await webcrypto.subtle.digest("SHA-1", data))
		}
		const key = await cryptoApiBlockKey(encryptionHeader({ scheme: "cryptoApiRc4", password: "pw", keySize: 128 }), decryption)

		await key.decryptBlock(new Uint8Array(8), 1)
		key.wipe()

		await expect(key.decryptBlock(new Uint8Array(8), 1)).rejects.toThrow("wiped")
	})
})

// One shape of n − 1 "\r" (n paragraphs) with n one-character paragraph and character runs.
async function manyRuns(n: number): Promise<Uint8Array> {
	const raw = new Uint8Array(n * 10 + n * 8)
	const view = new DataView(raw.buffer)

	for (let k = 0; k < n; k++) view.setUint32(k * 10, 1, true)
	for (let k = 0; k < n; k++) view.setUint32(n * 10 + k * 8, 1, true)

	return (await buildPpt({ slides: [{ shapes: [{ text: "\r".repeat(n - 1), anchor: [0, 0, 1000, 1000], rawStyle: raw }] }] })).bytes
}

describe("ppt style runs", () => {
	it("converts a body of 80,000 paragraphs and runs in linear time", { timeout: 120_000 }, async () => {
		const bytes = await manyRuns(80_000)
		const start = cpuMs()
		const result = await pptToPptx(bytesSource(bytes))

		expect(result.kind).toBe("converted")
		expect(cpuMs() - start).toBeLessThan(budget(2500))
	})

	it("refuses a body of more runs than the runs-per-body budget", { timeout: 60_000 }, async () => {
		expect(await pptToPptx(bytesSource(await manyRuns(100_002)))).toMatchObject({ kind: "refused", reason: "tooLarge" })
	})
})

describe("ppt actions", () => {
	it("carries macro, program and OLE click actions as refused actions", async () => {
		const shape = (k: number, click: FixtureShape["click"]): FixtureShape => ({
			text: `s${String(k)}`,
			anchor: [0, 100 * k, 100, 100 * k + 50],
			...(click === undefined ? {} : { click })
		})
		const built = await buildPpt({
			slides: [
				{
					shapes: [
						shape(0, { action: 1, name: "Module1.Run" }),
						shape(1, { action: 2, name: "C:\\Windows\\calc.exe" }),
						shape(2, { action: 5, oleVerb: 1 })
					]
				}
			]
		})
		const result = await pptToPptx(bytesSource(built.bytes))

		if (result.kind !== "converted") throw new Error(JSON.stringify(result))

		const opened = await openPptxPackage(result.pptx)

		if (opened.kind !== "opened") throw new Error(JSON.stringify(opened))

		const ref = opened.deck.slides[0]

		if (ref === undefined) throw new Error("no slide")

		const node = await opened.parts.slide(ref)
		const clicks = (node.shapes ?? []).map(child => child.actions?.click)

		expect(clicks).toEqual([
			{ kind: "refused", what: "macro", raw: "ppaction://macro?name=Module1.Run" },
			{ kind: "refused", what: "program", raw: "C:\\Windows\\calc.exe" },
			{ kind: "refused", what: "ole", raw: "ppaction://ole?verb=1" }
		])
		expect(result.losses.find(loss => loss.kind === "action")).toBeUndefined()
	})
})

async function openSession(
	bytes: Uint8Array,
	options: PresentationOpenOptions
): Promise<{ session: LoopbackSession; info: OpenInfo; stop: () => void }> {
	const channel = loopback()
	const stop = servePresentation(channel.worker)
	const session = new LoopbackSession(channel.page, 1)
	const event = session.nextEvent()

	channel.page.post({ t: "open", s: 1, source: { kind: "bytes", bytes }, options })

	const opened = await event

	if (opened.type !== "opened") throw new Error(JSON.stringify(opened))

	return { session, info: opened.info, stop }
}

describe("view-only sessions", () => {
	it("opens a ppt deck not editable and refuses commands, undo, redo and save with viewOnly", async () => {
		const bytes = (await buildPpt({ slides: [{ shapes: [{ text: "A", anchor: [100, 100, 1000, 1000] }] }, { shapes: [] }] })).bytes
		const { session, info, stop } = await openSession(bytes, { format: "ppt", fileName: "a.ppt" })
		const slide = info.slides[1]?.ref

		if (slide === undefined) throw new Error("no slide")

		expect(info.editable).toBe(false)
		expect(await session.call("command", { family: "slide", kind: "hide", slides: [slide], hidden: true }).answer).toEqual({
			ok: false,
			refusal: "viewOnly"
		})
		expect(await session.call("undo").answer).toEqual({ ok: false, refusal: "viewOnly" })
		expect(await session.call("redo").answer).toEqual({ ok: false, refusal: "viewOnly" })

		const { port1 } = new MessageChannel()

		expect(await session.call("save", { reason: "user", port: port1 }).answer).toEqual({ kind: "refused", reason: "viewOnly" })
		port1.close()
		stop()
	})

	it("honours the viewOnly open option on a pptx and leaves other decks editable", async () => {
		const bytes = buildPptx({ slides: [{ shapes: tree(sp(2, "A", undefined)) }, { shapes: tree("") }] })
		const shown = await openSession(bytes.slice(), { format: "pptx", fileName: "a.pptx", viewOnly: true })
		const slide = shown.info.slides[1]?.ref

		if (slide === undefined) throw new Error("no slide")

		expect(shown.info.editable).toBe(false)
		expect(await shown.session.call("command", { family: "slide", kind: "hide", slides: [slide], hidden: true }).answer).toEqual({
			ok: false,
			refusal: "viewOnly"
		})
		shown.stop()

		const edited = await openSession(bytes.slice(), { format: "pptx", fileName: "a.pptx" })

		expect(edited.info.editable).toBe(true)
		expect(await edited.session.call("command", { family: "slide", kind: "hide", slides: [slide], hidden: true }).answer).toMatchObject(
			{
				ok: true
			}
		)
		edited.stop()
	})
})
