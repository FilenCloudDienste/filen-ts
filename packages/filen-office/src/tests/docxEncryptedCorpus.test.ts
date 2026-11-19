import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { CfbFile } from "@filen/office/core/cfb"
import { bytesSource } from "@filen/office/core/opc"
import { passwordDataSpaces, readEncryptedContainer } from "@filen/office/core/encryption"
import { DocxEngine, type DocxEvent, type DocxHost } from "@filen/office/dom/docx"
import { parseEncryptionInfo } from "@filen/office/dom/encryption"
import type { CorpusManifest } from "../scripts/corpusManifest"
import { CORPUS_DIR } from "./corpusDir"
import {
	decrypted,
	documentXml,
	editAndSave,
	expectSealedUpload,
	plaintextOf,
	services,
	workerHarness,
	type WorkerHarness
} from "./docxEncryptedFixtures"

// Every password-protected Word document of the corpus through the path the apps take: refused or prompted
// before anything is shown, a wrong password and an abort retried, the decrypted package viewed and edited,
// every save sealed and checked, and the sealed file opened again with the password. The documents are unlocked
// and viewed in the docx worker (a MessagePort pair), the editor sealing on the test's thread with the taken key. An unedited save decrypts
// to the source's package byte for byte (its ciphertext differs: fresh salts).
//
// FILEN_OFFICE_SEAL_OUT=<dir> also writes each sealed save with its password and expected package, in the
// manifest form the encryption oracles read (src/tests/encryption/oracles: FILEN_OFFICE_SEALED=<dir>/all, or
// <dir>/nosha1 for tools that misread Agile SHA-1).

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "corpus", "manifest.json"), "utf8")) as CorpusManifest
const SAMPLES = manifest.files
	.filter(file => /^(docx|docm|dotx|dotm)\//u.test(file.path) && file.password !== undefined)
	.filter(file => existsSync(join(CORPUS_DIR, file.path)))
const MARKER = "Filen sealed edit "
const OUT = process.env["FILEN_OFFICE_SEAL_OUT"]

interface OracleEntry {
	readonly file: string
	readonly password: string
	readonly plaintext: string
}

const oracleEntries: { readonly entry: OracleEntry; readonly sha1: boolean }[] = []

function record(name: string, kind: string, sealed: Uint8Array, plaintext: Uint8Array, password: string, sha1: boolean): void {
	if (OUT === undefined || OUT === "") return

	mkdirSync(OUT, { recursive: true })

	const base = `${name.replace(/[^\w.-]+/gu, "_")}.${kind}`
	const file = join(OUT, `${base}.docx`)
	const plain = join(OUT, `${base}.zip`)

	writeFileSync(file, sealed)
	writeFileSync(plain, plaintext)
	oracleEntries.push({ entry: { file, password, plaintext: plain }, sha1 })

	for (const [dir, entries] of [
		["all", oracleEntries],
		["nosha1", oracleEntries.filter(item => !item.sha1)]
	] as const) {
		mkdirSync(join(OUT, dir), { recursive: true })
		writeFileSync(join(OUT, dir, "manifest.json"), JSON.stringify({ version: 1, entries: entries.map(item => item.entry) }, null, "\t"))
	}
}

// The viewer's open of a package: its gate reasons, or undefined when it failed. `host`: where the package is held.
async function viewerGate(bytes: Uint8Array, host?: DocxHost): Promise<readonly string[] | undefined> {
	const events: DocxEvent[] = []

	if (host === undefined) await new DocxEngine(bytesSource(bytes), services(), event => events.push(event)).run()
	else
		await new Promise<void>(resolve => {
			const session = host(bytesSource(bytes), event => {
				events.push(event)

				if (event.type === "error" || (event.type === "pages" && event.final)) {
					session.close()
					resolve()
				}
			})
		})

	const opened = events.find(event => event.type === "opened")

	return opened?.type === "opened" && !events.some(event => event.type === "error") ? opened.info.gate : undefined
}

const MSO2013_SAMPLE = join(CORPUS_DIR, "docx/lo__Encrypted_MSO2013_abc.docx")

describe.skipIf(SAMPLES.length === 0)("encrypted docx corpus", () => {
	let harness: WorkerHarness | undefined

	afterAll(() => harness?.dispose())
	it.each(SAMPLES.map(sample => [sample.path, sample.password ?? ""] as const))(
		"%s: prompts, retries, views, edits, saves sealed and reopens",
		{ timeout: 120_000 },
		async (path, password) => {
			const file = new Uint8Array(readFileSync(join(CORPUS_DIR, path)))
			// A document's password is asked for at once: no silent try of Excel's default.
			harness ??= workerHarness()

			const opened = await harness.pool.protection.open(bytesSource(file))

			if (opened.kind !== "needsPassword") throw new Error(`expected a prompt, got ${opened.kind}`)

			const { locked } = opened

			expect(await locked.unlock(`${password}x`)).toEqual({ ok: false, reason: "wrongPassword" })

			const signal = { aborted: false }
			const aborting = locked.unlock(password, { signal })

			setTimeout(() => (signal.aborted = true), 5)
			expect(await aborting).toEqual({ ok: false, reason: "aborted" })

			const document = decrypted(await locked.unlock(password))
			const source = await plaintextOfDocument(document)
			const gate = await viewerGate(source, document.host)

			expect(gate).toBeDefined()

			// POI's two samples are also write-protected: saved as once their password to modify is given.
			const { unedited, edited } = await editAndSave(document, MARKER, gate?.includes("writeProtected") === true)

			expectSealedUpload(unedited.bytes)

			expect(await plaintextOf(unedited.bytes, password)).toEqual(source)

			const agileSha1 = document.scheme === "agile" && (await sha1Source(file))

			record(path, "unedited", unedited.bytes, source, password, agileSha1)

			if (edited !== undefined) {
				expectSealedUpload(edited.bytes)

				const after = await plaintextOf(edited.bytes, password)

				expect(documentXml(after)).toContain(MARKER)
				expect(await viewerGate(after)).toEqual(gate)
				record(path, "edited", edited.bytes, after, password, agileSha1)
			}

			document.release()
		}
	)

	it.skipIf(!existsSync(MSO2013_SAMPLE))("writes the DataSpaces streams Word 2013 writes, byte for byte", async () => {
		const cfb = await CfbFile.open(bytesSource(new Uint8Array(readFileSync(MSO2013_SAMPLE))))

		for (const stream of passwordDataSpaces()) expect(await cfb.read(stream.path), stream.path.join("/")).toEqual(stream.bytes)
	})
})

async function sha1Source(file: Uint8Array): Promise<boolean> {
	const container = await readEncryptedContainer(await CfbFile.open(bytesSource(file)))
	const info = parseEncryptionInfo(container.encryptionInfo ?? new Uint8Array(0))

	return info.kind === "agile" && info.keyData.hash === "SHA-1"
}

async function plaintextOfDocument(document: { take(): Promise<{ readonly bytes: Uint8Array }> }): Promise<Uint8Array> {
	return (await document.take()).bytes
}
