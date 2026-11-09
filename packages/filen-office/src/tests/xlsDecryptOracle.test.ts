import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { CfbFile } from "@filen/office/core/cfb"
import { bytesSource } from "@filen/office/core/opc"
import type { DocDecryption } from "../core/doc/decrypt"
import { decryptXlsWorkbook, xlsEncryption } from "../core/xls/decrypt"
import { CORPUS_DIR } from "./corpusDir"
import { encryptedXlsStream, xlsFile, xlsLabel, xlsNumber, type XlsEncryptOptions } from "./encryption/xls"
import { msoffcryptoPython } from "./encryption/oracles/msoffcrypto"

// Our decrypted Workbook streams against msoffcrypto-tool's, byte for byte but the FilePass record's data (msoffcrypto
// zeroes it, we keep it). Opt-in through FILEN_OFFICE_MSOFFCRYPTO; corpus files when the corpus is fetched; extra
// files (path=password pairs separated by ";") through FILEN_OFFICE_XLS_ORACLE_FILES.

const python = msoffcryptoPython()
const SCRIPT = join(import.meta.dirname, "docDecryptOracle.py")
const scratch = python === undefined ? "" : mkdtempSync(join(tmpdir(), "xls-decrypt-oracle-"))

afterAll(() => {
	if (scratch !== "") rmSync(scratch, { recursive: true, force: true })
})

function decryption(password: string): DocDecryption {
	return { password, sha1: data => Promise.resolve(new Uint8Array(createHash("sha1").update(data).digest())) }
}

async function workbookOf(file: Uint8Array): Promise<Uint8Array> {
	return (await (await CfbFile.open(bytesSource(file))).read("Workbook")).slice()
}

function oracle(file: string, password: string): Uint8Array | string {
	const out = join(scratch, `${Math.random().toString(36).slice(2)}.xls`)
	const result = spawnSync(python ?? "", ["-I", SCRIPT, file, password, out], { encoding: "utf8", timeout: 120_000 })
	const answer = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") as { ok?: boolean; error?: string }

	return answer.ok === true ? readFileSync(out) : (answer.error ?? `exit ${result.status}`)
}

// Ours equals msoffcrypto's but inside the FilePass record (its header and the rest of the stream compared).
async function matches(path: string, password: string): Promise<boolean> {
	const file = new Uint8Array(readFileSync(path))
	const encryption = await xlsEncryption(file)

	if (encryption.kind !== "encrypted") throw new Error(`not encrypted: ${encryption.kind}`)

	const ours = await decryptXlsWorkbook(file, encryption, decryption(password))
	const theirs = oracle(path, password)

	if (ours.kind !== "decrypted") throw new Error(ours.kind)
	if (typeof theirs === "string") throw new Error(`msoffcrypto refused: ${theirs}`)

	const a = await workbookOf(ours.file)
	const b = await workbookOf(theirs)
	const bofSize = (a[2] ?? 0) | ((a[3] ?? 0) << 8)
	const filePassEnd = 4 + bofSize + 4 + encryption.filePass.length

	return a.length === b.length && Buffer.from(a.subarray(filePassEnd)).equals(b.subarray(filePassEnd))
}

// The encrypted .xls files in the corpus and their passwords: the default password to open ("VelvetSweatshop", a
// write-protected workbook), the one Apache Tika names the file for, or msoffcrypto-tool's fixture password.
const CORPUS: readonly (readonly [file: string, password: string])[] = [
	["xls/govuk__2163172.xls", "VelvetSweatshop"],
	["xls/govuk__phase-ii-ner-benchmarking.xls", "VelvetSweatshop"],
	["xls/mso__rc4cryptoapi_password.xls", "Password1234_"],
	["xls/mso__xor_password_123456789012345.xls", "123456789012345"],
	["xls/tika__testEXCEL_protected_passtika.xls", "tika"]
]

const EXTRA = (process.env["FILEN_OFFICE_XLS_ORACLE_FILES"] ?? "")
	.split(";")
	.filter(entry => entry.includes("="))
	.map(entry => [entry.slice(0, entry.lastIndexOf("=")), entry.slice(entry.lastIndexOf("=") + 1)] as const)

describe.skipIf(python === undefined)("encrypted .xls against msoffcrypto-tool", () => {
	// `corpus:fetch --family` may not have fetched every file yet.
	const present = CORPUS.filter(([file]) => existsSync(join(CORPUS_DIR, file)))

	it.skipIf(present.length === 0).each(present)("decrypts %s as msoffcrypto does", async (file, password) => {
		expect(await matches(join(CORPUS_DIR, file), password)).toBe(true)
	})

	it.skipIf(EXTRA.length === 0).each(EXTRA)("decrypts %s as msoffcrypto does", async (file, password) => {
		expect(await matches(file, password)).toBe(true)
	})

	const SYNTHETIC: readonly XlsEncryptOptions[] = [
		{ scheme: "xor", password: "secret" },
		{ scheme: "rc4", password: "password1" },
		{ scheme: "cryptoApiRc4", password: "Pässwort", keySize: 128 },
		{ scheme: "cryptoApiRc4", password: "Pässwort", keySize: 40 }
	]

	it.each(SYNTHETIC.map(options => [`${options.scheme} ${options.keySize ?? ""}`, options] as const))(
		"decrypts a %s fixture as msoffcrypto does",
		async (_, options) => {
			const records = Array.from({ length: 200 }, (_, k) =>
				k % 2 === 0 ? xlsLabel(k, 0, `row ${k} `.repeat(k % 5)) : xlsNumber(k, 1, k)
			)
			const { encrypted } = encryptedXlsStream([{ name: "Sheet1", records }], options)
			const path = join(scratch, `${options.scheme}-${options.keySize ?? 0}.xls`)

			writeFileSync(path, await xlsFile(encrypted))

			expect(await matches(path, options.password)).toBe(true)
		}
	)
})
