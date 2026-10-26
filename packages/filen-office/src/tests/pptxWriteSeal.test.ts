import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bytesSource, memorySink } from "@filen/office/core/opc"
import { agileStreams, encryptedOfficeFile, standardStreams } from "@filen/office/testing/encryption"
import { openEncryptedPackage, type DecryptedPackage } from "../dom/encryption/index"
import { packageSealer } from "../dom/encryption/seal"
import { savePptxSealed } from "../core/pptx/write/seal"
import { CORPUS_DIR } from "./corpusDir"
import { msoffcryptoPython } from "./encryption/oracles/msoffcrypto"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"
import { Changes, openDeck, shapeOf, slideNode } from "./pptxWriteFixtures"
import { budget } from "./timing"

// Saving an encrypted deck: the edited package is proved in memory and sealed as Agile under the session's key
// (a Standard source too); the sealed file opens with the same password, here and in msoffcrypto-tool.

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

// Opens the decrypted package, moves its first shape and saves sealed; returns the sealed file and the new x.
async function editAndSeal(decrypted: DecryptedPackage): Promise<{ readonly sealed: Uint8Array; readonly x: number }> {
	const opened = await openDeck(decrypted.bytes)
	const node = slideNode(opened, 0)
	const shape = node.shapes.find(candidate => candidate.kind === "sp" && candidate.lock === undefined)

	if (shape === undefined) throw new Error("no shape")

	const x = (shape.xfrm?.x ?? 0) + 12700

	shape.xfrm = { ...(shape.xfrm ?? { y: 0, cx: 914400, cy: 914400, rot: 0, flipH: false, flipV: false }), x }

	const { sealer, release } = packageSealer(decrypted.key)
	const sink = memorySink()

	try {
		const outcome = await savePptxSealed(
			{
				deck: opened.deck,
				source: opened.source,
				changes: new Changes().shape(node.part, shape.id, { kind: "xfrm" }).build(),
				revision: 1
			},
			sealer,
			sink
		)

		expect(outcome.kind).toBe("written")
	} finally {
		release()
	}

	return { sealed: sink.bytes(), x }
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
		const decrypted = await unlock(await encryptedOfficeFile(agileStreams(plainDeck(), PASSWORD, { spinCount: 1000 })), PASSWORD)
		const opened = await openDeck(decrypted.bytes)
		const { sealer, release } = packageSealer(decrypted.key)
		const sink = memorySink()

		try {
			expect(
				await savePptxSealed(
					{ deck: opened.deck, source: opened.source, changes: new Changes().build(), revision: 1 },
					sealer,
					sink
				)
			).toEqual({ kind: "unchanged" })
			expect(sink.bytes().length).toBe(0)
		} finally {
			release()
		}
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
				const { sealed, x } = await editAndSeal(await unlock(file, PASSWORD))
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
			const { sealed, x } = await editAndSeal(await unlock(new Uint8Array(readFileSync(TIKA)), "tika"))
			const again = await unlock(sealed, "tika")

			expect(again.scheme).toBe("agile")
			expect(await firstX(again.bytes)).toBe(x)

			const external = msoffcrypto(sealed, "tika")

			if (external !== undefined) expect(await firstX(external)).toBe(x)
		}
	)
})
