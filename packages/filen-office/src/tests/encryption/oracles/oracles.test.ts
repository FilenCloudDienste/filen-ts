import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { CorpusManifest } from "../../../scripts/corpusManifest"
import { CORPUS_DIR } from "../../corpusDir"
import { libreOffice, runLibreOffice } from "./lo"
import { msoffcryptoPython, runMsoffcrypto } from "./msoffcrypto"
import { poi as detectPoi, runPoi } from "./poi"
import { readSealedOutputs, sealedOutputsDir, type SealedOutputs } from "./outputs"

// External oracles for our encrypted output. Each is opt-in and skipped when its tool env is absent:
//   FILEN_OFFICE_MSOFFCRYPTO=<python>   a Python with msoffcrypto-tool
//   FILEN_OFFICE_POI=<dir> [FILEN_OFFICE_JAVA=<java>]   a directory of POI jars + a JDK
//   FILEN_OFFICE_SOFFICE=<soffice>      a LibreOffice install (its bundled Python is used)
// The sealed output to check is FILEN_OFFICE_SEALED (docxEncryptedCorpus.test.ts writes it with FILEN_OFFICE_SEAL_OUT;
// always Agile AES-256/SHA-512). Without it,
// the suite falls back to a fixed set of corpus samples of the same schemes, so the oracles are exercised
// wherever the corpus is fetched.

// Corpus samples whose scheme matches what we seal, with whether they carry an Agile data-integrity HMAC.
const SELF_TEST: readonly { readonly path: string; readonly agile: boolean }[] = [
	{ path: "docx/mso__example_password.docx", agile: true },
	{ path: "docx/lo__Encrypted_MSO2013_abc.docx", agile: true },
	{ path: "xlsx/poi__protected_sha512.xlsx", agile: true },
	{ path: "docx/lo__Encrypted_LO_Standard_abc.docx", agile: false },
	{ path: "pptx/tika__testPPT_protected_passtika.pptx", agile: false }
]

const COMMITTED = join(import.meta.dirname, "..", "..", "..", "..", "corpus")

interface SealedTarget {
	readonly outputs: SealedOutputs
	// Entry names that must verify a data-integrity HMAC.
	readonly agile: ReadonlySet<string>
}

// FILEN_OFFICE_SEALED (our sealed output: every entry Agile) when set; else a temporary manifest over the corpus
// samples above; else nothing (the suite skips).
function target(): SealedTarget | undefined {
	const sealed = sealedOutputsDir()

	if (sealed !== undefined) {
		const outputs = readSealedOutputs(sealed)

		return { outputs, agile: new Set(outputs.entries.map(entry => entry.name)) }
	}

	const manifest = JSON.parse(readFileSync(join(COMMITTED, "manifest.json"), "utf8")) as CorpusManifest
	const passwords = new Map(manifest.files.map(file => [file.path, file.password]))
	const present = SELF_TEST.filter(sample => existsSync(join(CORPUS_DIR, sample.path)) && passwords.get(sample.path) !== undefined)

	if (present.length === 0) return undefined

	const dir = mkdtempSync(join(tmpdir(), "filen-office-sealed-"))

	writeFileSync(
		join(dir, "manifest.json"),
		JSON.stringify({
			version: 1,
			entries: present.map(sample => ({ file: join(CORPUS_DIR, sample.path), password: passwords.get(sample.path) }))
		})
	)

	return {
		outputs: readSealedOutputs(dir),
		agile: new Set(present.filter(sample => sample.agile).map(sample => join(CORPUS_DIR, sample.path)))
	}
}

const sealed = target()
const msoffcrypto = msoffcryptoPython()
const poi = detectPoi()
const lo = libreOffice()
const anyOracle = msoffcrypto !== undefined || poi !== undefined || lo !== undefined

// A skipped describe still runs its body to collect the tests, so nothing here may assume `sealed` is set.
describe.skipIf(sealed === undefined || !anyOracle)("encryption oracles", () => {
	const entries = sealed?.outputs.entries ?? []
	const agile = sealed?.agile ?? new Set<string>()

	it("has at least one sealed entry to check", () => {
		expect(entries.length).toBeGreaterThan(0)
	})

	it.skipIf(msoffcrypto === undefined)("msoffcrypto-tool decrypts every sealed file", () => {
		for (const entry of entries) {
			const result = runMsoffcrypto(msoffcrypto as string, entry)

			expect(result.error, `${entry.name}: ${result.error}`).toBeUndefined()
			expect(result.ok).toBe(true)
			expect(result.startsPK).toBe(true)
			if (entry.plaintext !== undefined) expect(result.matchedPlaintext, `${entry.name} plaintext`).toBe(true)
			if (agile.has(entry.name) && result.integritySupported !== false) {
				expect(result.integrityVerified, `${entry.name} integrity`).toBe(true)
			}
		}
	})

	it.skipIf(poi === undefined)("Apache POI decrypts and verifies the HMAC of every sealed file", () => {
		for (const entry of entries) {
			const result = runPoi(poi!, entry)

			expect(result.error, `${entry.name}: ${result.error}`).toBeUndefined()
			expect(result.ok).toBe(true)
			expect(result.startsPK).toBe(true)
			if (entry.plaintext !== undefined) expect(result.matchedPlaintext, `${entry.name} plaintext`).toBe(true)
			if (agile.has(entry.name)) expect(result.hmacVerified, `${entry.name} HMAC`).toBe(true)
		}
	})

	it.skipIf(lo === undefined)("LibreOffice opens every sealed file with its password", { timeout: 300_000 }, () => {
		const results = runLibreOffice(lo!, entries)

		for (const entry of entries) {
			const result = results.get(entry.name)

			expect(result, `${entry.name}: no result`).toBeDefined()
			expect(result?.error, `${entry.name}: ${result?.error}`).toBeUndefined()
			expect(result?.ok).toBe(true)
		}
	})
})
