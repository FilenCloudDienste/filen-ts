import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { CfbFile } from "@filen/office/core/cfb"
import { bytesSource } from "@filen/office/core/opc"
import type { DocDecryption } from "../core/doc/decrypt"
import { decryptXlsWorkbook, xlsEncryption } from "../core/xls/decrypt"
import { CORPUS_DIR } from "./corpusDir"
import {
	encryptedXlsStream,
	xlsFile,
	xlsLabel,
	xlsNumber,
	xlsRecord,
	xlsWorkbookStream,
	type XlsEncryptOptions,
	type XlsSheetSpec
} from "./encryption/xls"

function decryption(password: string): DocDecryption {
	return { password, sha1: data => Promise.resolve(new Uint8Array(createHash("sha1").update(data).digest())) }
}

// Enough records for several 1024-byte RC4 blocks, records straddling their edges, and two sheets.
const SHEETS: readonly XlsSheetSpec[] = [
	{
		name: "First",
		records: Array.from({ length: 120 }, (_, k) =>
			k % 3 === 0 ? xlsLabel(k, 0, `text ${k} `.repeat(k % 7)) : xlsNumber(k, 1, k * 1.5)
		)
	},
	{ name: "Second", records: [xlsLabel(0, 0, "second sheet"), xlsNumber(1, 0, 42)] }
]

async function workbookOf(file: Uint8Array): Promise<Uint8Array> {
	const cfb = await CfbFile.open(bytesSource(file))

	return (await cfb.read("Workbook")).slice()
}

async function decrypted(options: XlsEncryptOptions, password = options.password) {
	const { plain, encrypted } = encryptedXlsStream(SHEETS, options)
	const file = await xlsFile(encrypted)
	const before = file.slice()
	const encryption = await xlsEncryption(file)

	if (encryption.kind !== "encrypted") throw new Error(encryption.kind)

	const result = await decryptXlsWorkbook(file, encryption, decryption(password))

	expect(file).toEqual(before)

	return { plain, encryption, result }
}

const SCHEMES: readonly XlsEncryptOptions[] = [
	{ scheme: "xor", password: "secret" },
	{ scheme: "xor", password: "123456789012345" },
	{ scheme: "rc4", password: "password1" },
	{ scheme: "rc4", password: "VelvetSweatshop" },
	{ scheme: "cryptoApiRc4", password: "Pässwort", keySize: 128 },
	{ scheme: "cryptoApiRc4", password: "Pässwort", keySize: 56 },
	{ scheme: "cryptoApiRc4", password: "Pässwort", keySize: 0 }
]

describe("encrypted Excel 97–2003 workbooks", () => {
	it.each(SCHEMES.map(options => [`${options.scheme} ${options.keySize ?? ""} ${options.password}`, options] as const))(
		"decrypts a %s Workbook stream to the plain one, the clear records and lbPlyPos kept",
		async (_, options) => {
			const { plain, encryption, result } = await decrypted(options)

			expect(encryption.scheme).toBe(options.scheme)

			if (result.kind !== "decrypted") throw new Error(result.kind)

			expect(Buffer.from(await workbookOf(result.file)).equals(plain)).toBe(true)
		}
	)

	it.each(SCHEMES.map(options => [options.scheme, options] as const))("answers a wrong %s password as wrong", async (_, options) => {
		expect((await decrypted(options, "not it")).result).toEqual({ kind: "wrongPassword" })
	})

	it("reads a workbook without a FilePass as plain, and a file that is no workbook as plain for its reader to refuse", async () => {
		expect(await xlsEncryption(await xlsFile(xlsWorkbookStream(SHEETS)))).toEqual({ kind: "plain" })
		expect(await xlsEncryption(new Uint8Array(600))).toEqual({ kind: "plain" })
	})

	it("finds the FilePass after a WriteProtect, and no later than that", async () => {
		const { encrypted } = encryptedXlsStream(SHEETS, { scheme: "rc4", password: "p" })
		const bof = encrypted.subarray(0, 4 + ((encrypted[2] ?? 0) | ((encrypted[3] ?? 0) << 8)))
		const rest = encrypted.subarray(bof.length)
		const protectedFirst = new Uint8Array([...bof, ...xlsRecord(0x0086), ...rest])
		const late = new Uint8Array([...bof, ...xlsRecord(0x00e1, new Uint8Array(2)), ...rest])

		expect((await xlsEncryption(await xlsFile(protectedFirst))).kind).toBe("encrypted")
		expect((await xlsEncryption(await xlsFile(late))).kind).toBe("plain")
	})

	it("refuses a cipher none of these is as unsupported, before any password", async () => {
		const otherType = xlsWorkbookStream(SHEETS, Uint8Array.of(2, 0, 0, 0))
		// An RC4 CryptoAPI header naming AES-128 (AlgID 0x660E).
		const { encrypted } = encryptedXlsStream(SHEETS, { scheme: "cryptoApiRc4", password: "p" })
		const aes = encrypted.slice()
		const filePassAt = 4 + ((aes[2] ?? 0) | ((aes[3] ?? 0) << 8))
		const algIdAt = filePassAt + 4 + 2 + 12 + 8

		aes.set([0x0e, 0x66, 0, 0], algIdAt)

		expect(await xlsEncryption(await xlsFile(otherType))).toEqual({ kind: "unsupported" })
		expect(await xlsEncryption(await xlsFile(aes))).toEqual({ kind: "unsupported" })
	})

	it("refuses a FilePass cut short as damaged", async () => {
		expect((await xlsEncryption(await xlsFile(xlsWorkbookStream(SHEETS, Uint8Array.of(0, 0, 1))))).kind).toBe("damaged")
		expect((await xlsEncryption(await xlsFile(xlsWorkbookStream(SHEETS, Uint8Array.of(1, 0, 4, 0, 2, 0, 4, 0))))).kind).toBe("damaged")
	})

	it("answers an RC4 header cut short as damaged when it is decrypted", async () => {
		const file = await xlsFile(xlsWorkbookStream(SHEETS, Uint8Array.of(1, 0, 1, 0, 1, 0, 9, 9)))
		const encryption = await xlsEncryption(file)

		if (encryption.kind !== "encrypted") throw new Error(encryption.kind)

		expect((await decryptXlsWorkbook(file, encryption, decryption("p"))).kind).toBe("damaged")
	})
})

// Records of a decrypted Workbook stream: the numbers of its NUMBER, RK and MULRK cells, and its SST record's body.
function workbookFacts(workbook: Uint8Array): { cells: number; sum: number; sst: string } {
	const view = new DataView(workbook.buffer, workbook.byteOffset, workbook.byteLength)
	const rk = (value: number): number => {
		const scratch = new DataView(new ArrayBuffer(8))

		scratch.setUint32(4, value & 0xfffffffc, true)

		const number = (value & 2) !== 0 ? value >> 2 : scratch.getFloat64(0, true)

		return (value & 1) !== 0 ? number / 100 : number
	}
	let cells = 0
	let sum = 0
	let sst = ""

	for (let at = 0; at + 4 <= workbook.length;) {
		const id = view.getUint16(at, true)
		const size = view.getUint16(at + 2, true)
		const body = at + 4

		if (id === 0x00bd) {
			for (let k = 0; k < (size - 6) / 6; k++) {
				cells++
				sum += rk(view.getUint32(body + 6 + k * 6, true))
			}
		} else if (id === 0x027e) {
			cells++
			sum += rk(view.getUint32(body + 6, true))
		} else if (id === 0x0203) {
			cells++
			sum += view.getFloat64(body + 6, true)
		} else if (id === 0x00fc && sst === "") {
			sst = createHash("sha256")
				.update(workbook.subarray(body, body + size))
				.digest("hex")
		}

		at = body + size
	}

	return { cells, sum, sst }
}

// Office's own encrypted workbooks from msoffcrypto-tool's fixtures, each with what the unencrypted copy Excel saved
// beside it (tests/outputs/*_plain.xls) holds: its cells' count and sum and its SST record. XOR obfuscation
// ([MS-OFFCRYPTO] §2.3.6) and RC4 CryptoAPI (§2.3.5) as Excel writes them, not as our own encryptor does.
const OFFICE_ENCRYPTED: readonly (readonly [file: string, password: string, scheme: string, facts: ReturnType<typeof workbookFacts>])[] = [
	[
		"xls/mso__xor_password_123456789012345.xls",
		"123456789012345",
		"xor",
		{ cells: 10920, sum: 2298660, sst: "af5570f5a1810b7af78caf4bc70a660f0df51e42baf91d4de5b2328de0e83dfc" }
	],
	[
		"xls/mso__rc4cryptoapi_password.xls",
		"Password1234_",
		"cryptoApiRc4",
		{ cells: 0, sum: 0, sst: "d21bcbe8ad20ba58ec87f68b0c8fb2ef8e6afd3a35cce73a2dd2944090cb0582" }
	]
]
const PRESENT = OFFICE_ENCRYPTED.filter(([file]) => existsSync(join(CORPUS_DIR, file)))

describe.skipIf(PRESENT.length === 0)("Excel-encrypted workbooks of the corpus", () => {
	it.each(PRESENT)("decrypts %s to what Excel saved unencrypted", async (file, password, scheme, facts) => {
		const bytes = new Uint8Array(readFileSync(join(CORPUS_DIR, file)))
		const encryption = await xlsEncryption(bytes)

		if (encryption.kind !== "encrypted") throw new Error(encryption.kind)

		expect(encryption.scheme).toBe(scheme)

		const result = await decryptXlsWorkbook(bytes, encryption, decryption(password))

		if (result.kind !== "decrypted") throw new Error(result.kind)

		expect(workbookFacts(await workbookOf(result.file))).toEqual(facts)
		// Not the password plus a character: XOR obfuscation keys on the first 15 characters only, as Excel does.
		expect((await decryptXlsWorkbook(bytes, encryption, decryption("not the password"))).kind).toBe("wrongPassword")
	})
})
