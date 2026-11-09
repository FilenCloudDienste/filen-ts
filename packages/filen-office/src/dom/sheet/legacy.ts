import { bytesSource, type ByteSource } from "../../core/opc/index"
import { openXlsxSession, type XlsxSessionOpen } from "../../core/sheet/commands"
import type {
	SheetEncryption,
	SheetEncryptionRefusal,
	SheetEvent,
	SheetLockedFile,
	SheetOpenOptions,
	SheetOpenResult,
	SheetSessionApi
} from "../../core/sheet/protocol"
import type { SheetFeature } from "../../core/sheet/registry"
import type { XlsxDocument } from "../../core/xlsx/edit/document"
import { XlsxReadError } from "../../core/xlsx/read/errors"
import { decryptXlsWorkbook, xlsEncryption, type XlsEncryption } from "../../core/xls/decrypt"
import { decryptionOf } from "../encryption/legacyDecryption"
import { packageSealer } from "../encryption/seal"
import { DEFAULT_OFFICE_PASSWORD, passwordOfficeKey } from "../encryption/webCrypto"

// Excel 97–2003 workbooks (.xls, .xlt), opened view-only from the .xlsx `convert` makes of them. One with a password to
// open ([MS-XLS] §2.4.117 FilePass: XOR, RC4, CryptoAPI RC4) is decrypted first: with Excel's default password
// ("VelvetSweatshop", a write-protected workbook) without asking, else with the one the user gives. Its session seals
// every save (Save as .xlsx) as an Agile package under that same password, as a Word 97–2003 document's .docx is
// sealed; the password itself is not kept. A cipher none of these is refused "unsupported", before any password.

// The .xlsx of an Excel 97–2003 compound file (web: hucre's BIFF8 reader); throws what it cannot read, an
// XlsxReadError "tooLarge" for a sheet past the cell limit.
export type LegacyWorkbookConverter = (file: Uint8Array) => Promise<Uint8Array>

type Encrypted = Extract<XlsEncryption, { kind: "encrypted" }>

type Unlocked =
	| { readonly kind: "opened"; readonly result: SheetOpenResult }
	| { readonly kind: "wrongPassword" }
	| { readonly kind: "refused"; readonly reason: SheetEncryptionRefusal }

interface LegacyContext {
	readonly options: SheetOpenOptions
	readonly onEvent: (event: SheetEvent) => void
	readonly features: readonly SheetFeature<XlsxDocument>[]
	readonly track: (session: SheetSessionApi) => void
	readonly convert: LegacyWorkbookConverter
}

function opened(result: XlsxSessionOpen, track: (session: SheetSessionApi) => void): SheetOpenResult {
	if (result.kind === "opened") track(result.session)

	return result
}

type Failed = Extract<SheetOpenResult, { kind: "failed" }>

// The .xlsx of `file`, or why it is not one.
async function converted(file: Uint8Array, convert: LegacyWorkbookConverter): Promise<Uint8Array | Failed> {
	try {
		return await convert(file)
	} catch (error) {
		const reason = error instanceof XlsxReadError && error.code === "tooLarge" ? "tooLarge" : "malformed"

		return { kind: "failed", reason, message: error instanceof Error ? error.message : String(error) }
	}
}

// Every save of the session sealed under a new Agile key for `password` (its spin runs at the first seal).
async function sealedUnder(password: string): Promise<SheetEncryption> {
	const held = packageSealer(await passwordOfficeKey(password))

	return { sealer: held.sealer, integrity: "unchecked", release: () => held.release() }
}

async function unlockWith(file: Uint8Array, encryption: Encrypted, password: string, context: LegacyContext): Promise<Unlocked> {
	const decrypted = await decryptXlsWorkbook(file, encryption, decryptionOf(password))

	switch (decrypted.kind) {
		case "wrongPassword":
			return decrypted
		case "unsupported":
			return { kind: "refused", reason: "unsupported" }
		case "damaged":
			return { kind: "refused", reason: "damaged" }
		case "decrypted":
			break
	}

	const xlsx = await converted(decrypted.file, context.convert)

	decrypted.file.fill(0)

	if (!(xlsx instanceof Uint8Array)) return { kind: "opened", result: xlsx }
	if (context.options.signal?.aborted === true) return { kind: "opened", result: { kind: "aborted" } }

	const sealing = await sealedUnder(password)
	let result: XlsxSessionOpen

	try {
		result = await openXlsxSession(bytesSource(xlsx), { ...context.options, encryption: sealing }, context.onEvent, context.features)
	} catch (error) {
		sealing.release()

		throw error
	}

	if (result.kind !== "opened") sealing.release()

	return { kind: "opened", result: opened(result, context.track) }
}

function lockedFile(file: Uint8Array, encryption: Encrypted, context: LegacyContext): SheetLockedFile {
	let held: Uint8Array | null = file
	let busy = false

	return {
		scheme: encryption.scheme,
		spinCount: 0,
		async unlock(password, unlockOptions = {}) {
			if (held === null || busy || unlockOptions.signal?.aborted === true) return { ok: false, reason: "aborted" }

			busy = true

			try {
				const signal = unlockOptions.signal ?? context.options.signal
				const unlocked = await unlockWith(held, encryption, password, {
					...context,
					options: { ...context.options, ...(signal !== undefined && { signal }) }
				})

				if (unlocked.kind !== "opened")
					return unlocked.kind === "wrongPassword"
						? { ok: false, reason: "wrongPassword" }
						: { ok: false, reason: unlocked.reason }

				const result = unlocked.result

				if (result.kind === "opened" && held === null) {
					result.session.close()

					return { ok: false, reason: "aborted" }
				}

				if (result.kind === "opened") {
					held = null

					return { ok: true, session: result.session, info: result.info }
				}

				return { ok: false, reason: result.kind === "aborted" ? "aborted" : "damaged" }
			} finally {
				busy = false
			}
		},
		dispose() {
			held = null
		}
	}
}

// Opens an Excel 97–2003 workbook; `source` is not an encrypted OOXML package (the caller opened that as one).
export async function openLegacyWorkbook(source: ByteSource, context: LegacyContext): Promise<SheetOpenResult> {
	const file = await source.read(0, source.size)
	const encryption = await xlsEncryption(file)

	switch (encryption.kind) {
		case "unsupported":
			return { kind: "refused", reason: "unsupported" }
		case "damaged":
			return { kind: "refused", reason: "damaged" }
		case "plain": {
			const xlsx = await converted(file, context.convert)

			if (!(xlsx instanceof Uint8Array)) return xlsx

			return opened(await openXlsxSession(bytesSource(xlsx), context.options, context.onEvent, context.features), context.track)
		}
		case "encrypted":
			break
	}

	const unlocked = await unlockWith(file, encryption, DEFAULT_OFFICE_PASSWORD, context)

	switch (unlocked.kind) {
		case "opened":
			return unlocked.result
		case "refused":
			return { kind: "refused", reason: unlocked.reason }
		case "wrongPassword":
			return { kind: "needsPassword", locked: lockedFile(file, encryption, context) }
	}
}
