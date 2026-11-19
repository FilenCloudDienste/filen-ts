import { describe, expect, it } from "vitest"
import { CfbFile } from "../core/cfb/index"
import { isSealedOfficeFile } from "../core/encryption/index"
import { bytesSource } from "../core/opc/index"
import type { SheetOpenResult } from "../core/sheet/protocol"
import { inThreadSheetHost, type SheetHostOptions } from "../dom/sheet/host"
import { readCfbStreams } from "./encryption/cfbStreams"
import { decryptAgileStreams } from "./encryption/generate"
import { agileStreams, encryptedOfficeFile } from "./encryption/testing"
import {
	encryptedXlsStream,
	xlsFile,
	xlsLabel,
	xlsNumber,
	xlsWorkbookStream,
	type XlsEncryptOptions,
	type XlsSheetSpec
} from "./encryption/xls"
import { BASIC, IMMEDIATE, buildFixture, workerPair } from "./sheetSessionFixtures"

// An Excel 97–2003 workbook with a password to open, as the sheet host opens it: decrypted with Excel's default
// password without asking, else after the prompt; its Save as .xlsx sealed under the same password. The BIFF8 reader
// is stood in for by a converter that checks it was handed the plain Workbook stream.

const SHEETS: readonly XlsSheetSpec[] = [{ name: "Sheet1", records: [xlsLabel(0, 0, "Item"), xlsNumber(1, 0, 12.5)] }]

function opened(result: SheetOpenResult): Extract<SheetOpenResult, { kind: "opened" }> {
	if (result.kind !== "opened") throw new Error(`expected an open, got ${result.kind}`)

	return result
}

function locked(result: SheetOpenResult): Extract<SheetOpenResult, { kind: "needsPassword" }>["locked"] {
	if (result.kind !== "needsPassword") throw new Error(`expected a password prompt, got ${result.kind}`)

	return result.locked
}

// A converter that gives BASIC's .xlsx for exactly `plain` as the Workbook stream, and records each call.
function converter(plain: Uint8Array): { readonly options: SheetHostOptions; readonly calls: string[] } {
	const calls: string[] = []

	return {
		calls,
		options: {
			legacy: async file => {
				const stream = await (await CfbFile.open(bytesSource(file))).read("Workbook")

				if (!Buffer.from(stream).equals(plain)) {
					calls.push("garbled")

					throw new Error("Failed to parse XLS workbook (malformed or truncated)")
				}

				calls.push("plain")

				return buildFixture(BASIC)
			}
		}
	}
}

async function encryptedXls(options: XlsEncryptOptions): Promise<{ readonly file: Uint8Array; readonly plain: Uint8Array }> {
	const { plain, encrypted } = encryptedXlsStream(SHEETS, options)

	return { file: await xlsFile(encrypted), plain }
}

// The .xlsx inside a sealed save, for `password`.
function unsealed(bytes: Uint8Array, password: string): Buffer {
	const streams = readCfbStreams(bytes)

	return decryptAgileStreams(
		{
			encryptionInfo: streams.stream("EncryptionInfo") ?? new Uint8Array(0),
			encryptedPackage: streams.stream("EncryptedPackage") ?? new Uint8Array(0)
		},
		password
	)
}

// Each sealed save spins an Agile key 100,000 times.
describe("Excel 97–2003 workbooks with a password to open", { timeout: 60_000 }, () => {
	it.each([["rc4"], ["xor"], ["cryptoApiRc4"]] as const)(
		"opens a %s workbook encrypted with the default password without asking, view-only, its save sealed under it",
		async scheme => {
			const { file, plain } = await encryptedXls({ scheme, password: "VelvetSweatshop" })
			const { options, calls } = converter(plain)
			const result = opened(await inThreadSheetHost(options).open(file, { kind: "xls", slicing: IMMEDIATE }, () => undefined))

			expect(calls).toEqual(["plain"])
			expect(result.info.encrypted).toBe("unchecked")
			expect(await result.session.intent()).toEqual({ state: "viewOnly", reason: "legacyFormat" })

			const saved = await result.session.save()

			if (!saved.ok) throw new Error(saved.message)

			expect(isSealedOfficeFile(saved.bytes)).toBe(true)
			expect(unsealed(saved.bytes, "VelvetSweatshop").subarray(0, 2).toString()).toBe("PK")
			result.session.close()
		}
	)

	it.each([["rc4"], ["xor"], ["cryptoApiRc4"]] as const)("asks for the password of a %s workbook, refusing a wrong one", async scheme => {
		const { file, plain } = await encryptedXls({ scheme, password: "secret" })
		const { options, calls } = converter(plain)
		const lock = locked(await inThreadSheetHost(options).open(file, { kind: "xls", slicing: IMMEDIATE }, () => undefined))

		expect(lock.scheme).toBe(scheme)
		expect(await lock.unlock("wrong")).toEqual({ ok: false, reason: "wrongPassword" })

		const unlocked = await lock.unlock("secret")

		if (!unlocked.ok) throw new Error(unlocked.reason)

		expect(calls).toEqual(["plain"])

		const saved = await unlocked.session.save()

		if (!saved.ok) throw new Error(saved.message)

		// Sealed under the same password, never the plain package.
		expect(isSealedOfficeFile(saved.bytes)).toBe(true)
		expect(unsealed(saved.bytes, "secret").subarray(0, 2).toString()).toBe("PK")
		expect(() => unsealed(saved.bytes, "VelvetSweatshop")).toThrow()
		unlocked.session.close()
	})

	it("unlocks through a worker host as on the thread", async () => {
		const { file, plain } = await encryptedXls({ scheme: "rc4", password: "secret" })
		const { host, close } = workerPair(converter(plain).options)
		const lock = locked(await host.open(file, { kind: "xlt" }, () => undefined))

		expect(lock.scheme).toBe("rc4")
		expect(lock.spinCount).toBe(0)

		const unlocked = await lock.unlock("secret")

		if (!unlocked.ok) throw new Error(unlocked.reason)

		expect(unlocked.info.encrypted).toBe("unchecked")
		unlocked.session.close()
		close()
	})

	it("answers an unlock after the prompt went as aborted", async () => {
		const { file, plain } = await encryptedXls({ scheme: "rc4", password: "secret" })
		const lock = locked(
			await inThreadSheetHost(converter(plain).options).open(file, { kind: "xls", slicing: IMMEDIATE }, () => undefined)
		)

		lock.dispose()

		expect(await lock.unlock("secret")).toEqual({ ok: false, reason: "aborted" })
	})

	it("refuses a cipher none of these is as unsupported, without asking", async () => {
		const file = await xlsFile(xlsWorkbookStream(SHEETS, Uint8Array.of(2, 0, 0, 0)))
		const result = await inThreadSheetHost(converter(new Uint8Array(0)).options).open(
			file,
			{ kind: "xls", slicing: IMMEDIATE },
			() => undefined
		)

		expect(result).toEqual({ kind: "refused", reason: "unsupported" })
	})

	it("opens a plain workbook from its conversion, unencrypted, and fails one the converter cannot read as malformed", async () => {
		const plain = xlsWorkbookStream(SHEETS)
		const result = opened(
			await inThreadSheetHost(converter(plain).options).open(
				await xlsFile(plain),
				{ kind: "xls", slicing: IMMEDIATE },
				() => undefined
			)
		)

		expect(result.info.encrypted).toBeUndefined()

		const saved = await result.session.save()

		expect(saved.ok && !isSealedOfficeFile(saved.bytes)).toBe(true)
		result.session.close()

		const failed = await inThreadSheetHost(converter(new Uint8Array(1)).options).open(
			await xlsFile(plain),
			{ kind: "xls", slicing: IMMEDIATE },
			() => undefined
		)

		expect(failed.kind === "failed" && failed.reason).toBe("malformed")
	})

	it("opens an encrypted OOXML package under an .xls name as the workbook it is", async () => {
		const file = await encryptedOfficeFile(agileStreams(buildFixture(BASIC), "VelvetSweatshop", { spinCount: 1000 }))
		const { options, calls } = converter(new Uint8Array(0))
		const result = opened(await inThreadSheetHost(options).open(file, { kind: "xls", slicing: IMMEDIATE }, () => undefined))

		expect(calls).toEqual([])
		expect(result.info.kind).toBe("xlsx")
		result.session.close()
	})
})
