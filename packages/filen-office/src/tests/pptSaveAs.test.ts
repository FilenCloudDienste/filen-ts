import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deflateSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import { bytesSource, memorySink } from "../core/opc/index"
import { pptToPptx } from "../core/ppt/toPptx"
import { openPptx } from "../core/pptx/package"
import { decryptionOf } from "../dom/encryption/legacyDecryption"
import { openEncryptedPackage } from "../dom/encryption/index"
import { isSealedOfficeFile } from "../dom/encryption/seal"
import { pptSaveAs } from "../dom/presentation/engine/convert"
import { CORPUS_DIR } from "./corpusDir"
import { msoffcryptoPython } from "./encryption/oracles/msoffcrypto"
import { buildPpt, concat, container, record } from "./pptFixtures"
import { budget } from "./timing"

// Save as .pptx of a PowerPoint 97–2003 deck: the converted package written as a file, with the deck's transitions,
// animations, comments, movies, sounds and embedded objects in it; the same deck always gives the same bytes; an
// encrypted deck's copy is sealed as Agile under its password.

function u16(value: number): Uint8Array {
	return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff)
}

function u32(value: number): Uint8Array {
	const out = new Uint8Array(4)

	new DataView(out.buffer).setUint32(0, value >>> 0, true)

	return out
}

function utf16(text: string): Uint8Array {
	const out = new Uint8Array(text.length * 2)

	for (let k = 0; k < text.length; k++) out[2 * k] = text.charCodeAt(k)

	return out
}

const cString = (instance: number, text: string): Uint8Array => record(0x0fba, utf16(text), instance)
// A 1 × 1 PNG.
const PNG = Uint8Array.from(
	Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABc3UBGAAAAABJRU5ErkJggg==", "base64")
)
const STORAGE = Uint8Array.from({ length: 4096 }, (_, k) => (k * 31) % 251)

// SlideShowSlideInfoAtom: wipe right, advanced after 2 s, the collection's sound 3 played.
const TRANSITION = record(0x03f9, concat(u32(2000), u32(3), Uint8Array.of(2, 10), u16(0x1 | 0x10 | 0x400), Uint8Array.of(2, 0, 0, 0)))
// The "___PPT10" tag with one comment.
const COMMENTS = container(0x1388, [
	container(0x138a, [
		cString(0, "___PPT10"),
		record(
			0x138b,
			container(0x2ee0, [
				cString(0, "Ann"),
				cString(1, "Looks good"),
				cString(2, "A"),
				record(0x2ee1, concat(u32(1), ...[2020, 5, 1, 4, 10, 30, 0, 0].map(u16), u32(100), u32(200)))
			]),
			0,
			0
		)
	])
])
// An Office 97 build: fly in from the left on click.
const BUILD = container(0x1014, [
	record(
		0x0ff1,
		concat(Uint8Array.of(0, 0, 0, 0xfe, 0, 0x44, 0, 0), u32(0), u32(0), Uint8Array.of(1, 0, 0, 0, 1, 12, 0, 0, 0, 0, 0, 0)),
		0,
		1
	)
])

function deck(password?: string): Promise<{ readonly bytes: Uint8Array }> {
	return buildPpt({
		png: PNG,
		...(password === undefined ? {} : { password }),
		slides: [
			{
				shapes: [{ text: "Fly in", anchor: [100, 100, 2000, 600], clientData: [BUILD] }],
				records: [TRANSITION, COMMENTS]
			},
			{
				shapes: [
					{ picture: true, anchor: [100, 100, 1000, 800], clientData: [record(0x0bc1, u32(1))] },
					{ picture: true, oleShape: true, anchor: [1000, 100, 2000, 800], clientData: [record(0x0bc1, u32(2))] }
				]
			}
		],
		documentRecords: [
			container(0x0409, [
				container(0x1006, [container(0x1005, [record(0x1004, concat(u32(1), u32(0))), cString(0, "C:\\clips\\intro.avi")])]),
				container(0x0fcc, [
					record(0x0fcd, concat(u32(0), u32(0))),
					record(0x0fc3, concat(u32(1), u32(0), u32(2), u32(3), u32(100), u32(0))),
					cString(2, "Excel.Sheet.8")
				])
			]),
			container(
				0x07e4,
				[
					record(0x07e5, u32(3)),
					container(0x07e6, [
						cString(0, "Chime"),
						cString(1, ".wav"),
						cString(2, "3"),
						record(0x07e7, Uint8Array.of(82, 73, 70, 70))
					])
				],
				5
			)
		],
		objects: new Map([[100, record(0x1011, concat(u32(STORAGE.length), new Uint8Array(deflateSync(STORAGE))), 1)]])
	})
}

async function saveAs(source: Uint8Array, password?: string): Promise<Uint8Array> {
	const converted = await pptToPptx(bytesSource(source), password === undefined ? {} : { decryption: decryptionOf(password) })

	if (converted.kind !== "converted") throw new Error(converted.reason)

	const sink = memorySink()

	await pptSaveAs(converted.pptx, password, sink)
	converted.release()

	return sink.bytes()
}

async function partText(file: Uint8Array, name: string): Promise<string> {
	const opened = await openPptx(bytesSource(file))

	if (opened.kind !== "opened") throw new Error(opened.reason)

	return new TextDecoder().decode(await opened.parts.opc.read(name))
}

describe("ppt Save as .pptx", () => {
	it("writes the deck with its transitions, animations, comments, media and embedded objects, nothing reported lost", async () => {
		const source = (await deck()).bytes
		const converted = await pptToPptx(bytesSource(source))

		if (converted.kind !== "converted") throw new Error(converted.reason)

		expect(converted.losses).toEqual([])

		const file = await saveAs(source)
		const opened = await openPptx(bytesSource(file))

		if (opened.kind !== "opened") throw new Error(opened.reason)

		expect(opened.deck.slides).toHaveLength(2)

		const first = await partText(file, "ppt/slides/slide1.xml")
		const second = await partText(file, "ppt/slides/slide2.xml")

		expect(first).toContain('<p:transition advTm="2000"><p:wipe dir="r"/><p:sndAc><p:stSnd><p:snd r:embed="')
		expect(first).toContain('presetID="2" presetClass="entr" presetSubtype="8"')
		expect(await partText(file, "ppt/comments/comment1.xml")).toContain(
			'<p:cm authorId="0" dt="2020-05-04T10:30:00.000" idx="1"><p:pos x="100" y="200"/><p:text>Looks good</p:text></p:cm>'
		)
		expect(await partText(file, "ppt/commentAuthors.xml")).toContain('name="Ann" initials="A" lastIdx="1"')
		expect(await partText(file, "ppt/_rels/presentation.xml.rels")).toContain("relationships/commentAuthors")
		expect(second).toMatch(/<p:nvPr><a:videoFile r:link="rId\d+"\/><\/p:nvPr>/u)
		expect(await partText(file, "ppt/slides/_rels/slide2.xml.rels")).toContain(
			'Target="file:///C:/clips/intro.avi" TargetMode="External"'
		)
		expect(second).toContain('<p:oleObj r:id="')
		expect(second).toContain('progId="Excel.Sheet.8"><p:embed/><p:pic>')
		expect(await opened.parts.opc.read("ppt/embeddings/oleObject1.bin")).toEqual(STORAGE)
		expect(await opened.parts.opc.read("ppt/media/audio1.wav")).toEqual(Uint8Array.of(82, 73, 70, 70))
	})

	it("gives the same bytes every time", async () => {
		const source = (await deck()).bytes

		expect(await saveAs(source)).toEqual(await saveAs(source))
	})

	it("seals an encrypted deck's copy as Agile under its password", { timeout: budget(120_000) }, async () => {
		const password = "Secret ppt"
		const plain = await saveAs((await deck()).bytes)
		const sealed = await saveAs((await deck(password)).bytes, password)

		expect(isSealedOfficeFile(sealed)).toBe(true)

		const open = await openEncryptedPackage(bytesSource(sealed))

		if (open.kind !== "needsPassword") throw new Error(open.kind)

		expect((await open.locked.unlock("wrong")).ok).toBe(false)

		const unlocked = await open.locked.unlock(password)

		if (!unlocked.ok) throw new Error(unlocked.reason)

		expect(unlocked.document.bytes).toEqual(plain)

		// Opt-in through FILEN_OFFICE_MSOFFCRYPTO (a Python with msoffcrypto-tool installed).
		const python = msoffcryptoPython()

		if (python === undefined) return

		const directory = mkdtempSync(join(tmpdir(), "ppt-save-as-"))

		try {
			writeFileSync(join(directory, "in.pptx"), sealed)

			const detect = spawnSync(python, ["-I", "-m", "msoffcrypto", "-t", "-v", join(directory, "in.pptx")], { encoding: "utf8" })

			expect(detect.stdout + detect.stderr).toMatch(/agile/iu)

			const run = spawnSync(
				python,
				["-I", "-m", "msoffcrypto", "-p", password, join(directory, "in.pptx"), join(directory, "out.pptx")],
				{
					encoding: "utf8"
				}
			)

			expect(run.status).toBe(0)
			expect(new Uint8Array(readFileSync(join(directory, "out.pptx")))).toEqual(plain)
		} finally {
			rmSync(directory, { recursive: true, force: true })
		}
	})

	const corpus = join(CORPUS_DIR, "ppt")

	it.skipIf(!existsSync(corpus))(
		"saves every corpus deck as a .pptx the pptx reader opens, twice to the same bytes",
		{ timeout: budget(600_000) },
		async () => {
			const failed: string[] = []
			let saved = 0

			for (const name of readdirSync(corpus)) {
				const source = new Uint8Array(readFileSync(join(corpus, name)))
				const converted = await pptToPptx(bytesSource(source))

				if (converted.kind !== "converted") continue

				const first = memorySink()
				const second = memorySink()

				await pptSaveAs(converted.pptx, undefined, first)
				await pptSaveAs(converted.pptx, undefined, second)

				const opened = await openPptx(bytesSource(first.bytes()))

				if (opened.kind !== "opened" || opened.deck.slides.length !== converted.slides) failed.push(`${name}: ${opened.kind}`)
				else if (Buffer.compare(first.bytes(), second.bytes()) !== 0) failed.push(`${name}: second save differs`)
				else saved++
			}

			expect(failed).toEqual([])
			expect(saved).toBeGreaterThan(90)
		}
	)
})
