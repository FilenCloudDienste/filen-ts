import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bytesSource, memorySink, type ByteSink } from "@filen/office/core/opc"
import { agileStreams, encryptedOfficeFile, standardStreams } from "@filen/office/testing/encryption"
import { openEncryptedPackage, type DecryptedPackage } from "../dom/encryption/index"
import { sealInto } from "../core/pptx/write/seal"
import { CORPUS_DIR } from "./corpusDir"
import { msoffcryptoPython } from "./encryption/oracles/msoffcrypto"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"
import { openDeck, shapeOf, slideNode } from "./pptxWriteFixtures"
import { openSealedSession } from "./sealedSaveHarness"
import { budget } from "./timing"

// Saving an encrypted deck as a user does (saveSession with the shipped dependencies): the edited package is proved
// in memory and sealed as Agile under the session's key (a Standard source too); the sealed file opens with the same
// password, here and in msoffcrypto-tool.

const PASSWORD = "Secret pptx"
const TIKA = join(CORPUS_DIR, "pptx", "tika__testPPT_protected_passtika.pptx")

function plainDeck(): Uint8Array {
	return buildPptx({
		slides: [
			{
				shapes: sp(
					5,
					"Box",
					undefined,
					`${xfrm(100, 200, 300, 400)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`,
					body(para("Sealed"))
				)
			}
		]
	})
}

async function unlock(file: Uint8Array, password: string): Promise<DecryptedPackage> {
	const open = await openEncryptedPackage(bytesSource(file))

	if (open.kind !== "needsPassword") throw new Error(`not locked: ${open.kind}`)

	const unlocked = await open.locked.unlock(password)

	if (!unlocked.ok) throw new Error(unlocked.reason)

	return unlocked.document
}

// Opens the encrypted file, moves its first shape and saves; returns the sealed file the upload received and the new x.
async function editAndSeal(file: Uint8Array, password: string): Promise<{ readonly sealed: Uint8Array; readonly x: number }> {
	const session = await openSealedSession(file, password)

	try {
		const node = await session.slide(0)
		const shape = node.shapes.find(candidate => candidate.kind === "sp" && candidate.lock === undefined)

		if (shape === undefined) throw new Error("no shape")

		const x = (shape.xfrm?.x ?? 0) + 12700

		shape.xfrm = { ...(shape.xfrm ?? { y: 0, cx: 914400, cy: 914400, rot: 0, flipH: false, flipV: false }), x }
		session.moved(node, shape.id)

		const saved = await session.save()

		expect(saved.result).toMatchObject({ kind: "written" })

		if (saved.file === undefined) throw new Error("no file")

		return { sealed: saved.file, x }
	} finally {
		session.close()
	}
}

async function firstX(bytes: Uint8Array): Promise<number | undefined> {
	const opened = await openDeck(bytes)

	return slideNode(opened, 0).shapes.find(candidate => candidate.kind === "sp" && candidate.lock === undefined)?.xfrm?.x
}

function msoffcrypto(sealed: Uint8Array, password: string): Uint8Array | undefined {
	// Opt-in through FILEN_OFFICE_MSOFFCRYPTO (a Python with msoffcrypto-tool installed), like the other decryption oracles.
	const python = msoffcryptoPython()

	if (python === undefined) return undefined

	const directory = mkdtempSync(join(tmpdir(), "pptx-seal-"))

	try {
		writeFileSync(join(directory, "in.pptx"), sealed)

		const detect = spawnSync(python, ["-I", "-m", "msoffcrypto", "-t", "-v", join(directory, "in.pptx")], { encoding: "utf8" })

		expect(detect.stdout + detect.stderr).toMatch(/agile/iu)

		const run = spawnSync(
			python,
			["-I", "-m", "msoffcrypto", "-p", password, join(directory, "in.pptx"), join(directory, "out.pptx")],
			{ encoding: "utf8" }
		)

		if (run.status !== 0) throw new Error(`msoffcrypto-tool failed: ${run.stderr}`)

		return new Uint8Array(readFileSync(join(directory, "out.pptx")))
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}

describe("pptx sealed save", () => {
	it("saves an untouched encrypted deck as unchanged (nothing sealed or uploaded)", async () => {
		const session = await openSealedSession(
			await encryptedOfficeFile(agileStreams(plainDeck(), PASSWORD, { spinCount: 1000 })),
			PASSWORD
		)

		try {
			expect(await session.save()).toEqual({ result: { kind: "unchanged" }, file: undefined })
		} finally {
			session.close()
		}
	})

	// The seal rejects in the save's turn (the zip already written in memory) and the save's catch answers it.
	it("refuses the save, with no file, once the session released the deck's key", async () => {
		const session = await openSealedSession(
			await encryptedOfficeFile(agileStreams(plainDeck(), PASSWORD, { spinCount: 1000 })),
			PASSWORD
		)
		const node = await session.slide(0)
		const shape = shapeOf(node, 5)

		shape.xfrm = { ...(shape.xfrm ?? { x: 0, y: 0, cx: 914400, cy: 914400, rot: 0, flipH: false, flipV: false }), x: 25400 }
		session.moved(node, shape.id)
		session.close()

		const saved = await session.save()

		expect(saved.result).toMatchObject({ kind: "refused", reason: "notImplemented" })
		expect(saved.file).toBeUndefined()
	})

	for (const scheme of ["agile", "standard"] as const) {
		it(
			`seals the edited save of a ${scheme} deck as Agile; it opens with the password, here and in msoffcrypto-tool`,
			{ timeout: budget(60_000) },
			async () => {
				const plain = plainDeck()
				const file = await encryptedOfficeFile(
					scheme === "agile" ? agileStreams(plain, PASSWORD, { spinCount: 1000 }) : standardStreams(plain, PASSWORD)
				)
				const { sealed, x } = await editAndSeal(file, PASSWORD)
				const again = await unlock(sealed, PASSWORD)

				expect(again.scheme).toBe("agile")
				expect(again.integrity).toBe("verified")
				expect(shapeOf(slideNode(await openDeck(again.bytes), 0), 5).xfrm?.x).toBe(x)

				const external = msoffcrypto(sealed, PASSWORD)

				if (external !== undefined) expect(await firstX(external)).toBe(x)
			}
		)
	}

	it.skipIf(!existsSync(TIKA))(
		"seals the edited save of the corpus's Standard-encrypted deck as Agile",
		{ timeout: budget(60_000) },
		async () => {
			const { sealed, x } = await editAndSeal(new Uint8Array(readFileSync(TIKA)), "tika")
			const again = await unlock(sealed, "tika")

			expect(again.scheme).toBe("agile")
			expect(await firstX(again.bytes)).toBe(x)

			const external = msoffcrypto(sealed, "tika")

			if (external !== undefined) expect(await firstX(external)).toBe(x)
		}
	)
})

// The step every sealed write runs (the save above, and a protected source's conversion to PresentationML).
describe("sealed writes", () => {
	function recording(): ByteSink & { readonly chunks: number[]; closed: boolean } {
		const chunks: number[] = []
		const sink = {
			chunks,
			closed: false,
			write: (chunk: Uint8Array) => {
				chunks.push(chunk.length)

				return Promise.resolve()
			},
			close: () => {
				sink.closed = true

				return Promise.resolve()
			}
		}

		return sink
	}

	it("seals the zip it is given, shows the sealed file before writing it in 1 MiB chunks, then closes the sink", async () => {
		const zip = new Uint8Array([0x50, 0x4b, 3, 4])
		const file = new Uint8Array(2.5 * 1024 * 1024)

		for (let at = 0; at < file.length; at++) file[at] = at % 253

		const sink = recording()
		const kept = memorySink()
		let given: Uint8Array | undefined
		let shown: number[] | undefined

		const sealed = await sealInto(
			zip,
			bytes => {
				given = bytes

				return Promise.resolve(file)
			},
			sink,
			bytes => {
				shown = [bytes.length, sink.chunks.length]
			}
		)

		expect(given).toBe(zip)
		expect(sealed).toBe(file)
		expect(shown).toEqual([file.length, 0])
		expect(sink.chunks).toEqual([1024 * 1024, 1024 * 1024, 0.5 * 1024 * 1024])
		expect(sink.closed).toBe(true)

		await sealInto(zip, () => Promise.resolve(file), kept)
		expect(kept.bytes()).toEqual(file)
	})

	it("writes nothing and leaves the sink open when the seal rejects (a released key)", async () => {
		const sink = recording()

		await expect(sealInto(new Uint8Array(4), () => Promise.reject(new Error("released")), sink)).rejects.toThrow("released")
		expect(sink.chunks).toEqual([])
		expect(sink.closed).toBe(false)
	})
})
