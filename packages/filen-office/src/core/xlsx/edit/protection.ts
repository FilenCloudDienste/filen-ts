import { SHEET_MAX_COLS, SHEET_MAX_ROWS, type SheetId, type SheetProtectedAction } from "../../sheet/protocol"
import { defineSheetFeature, type SheetChangeSink, type SheetHandled } from "../../sheet/registry"
import { decodeUtf8 } from "../../xml/index"
import type { XlsxProtectionHash, XlsxSheetProtection, XlsxWorkbookProtection } from "../model/types"
import type { XlsxDocument } from "./document"

// Sheet and workbook protection set and taken off (ECMA-376 Part 1 §18.3.1.85 sheetProtection, §18.2.29
// workbookProtection). The session honours it before any handler runs (locked cells, the allowed actions, the
// workbook's structure). A password is checked by the app before it asks to take protection off: the core hashes
// nothing but the legacy 16-bit verifier ([MS-OFFCRYPTO] §2.3.7.1), and a new protection's hash is made on the
// platform (dom/protection.ts, [MS-OFFCRYPTO] §2.4.2.4). Neither is a security boundary ([MS-OFFCRYPTO] §4.1.4).

// A password hash as the file writes it: the modern one (algorithmName, hashValue, saltValue, spinCount) or the
// legacy 16-bit verifier as hex.
export interface SheetPasswordHash {
	readonly algorithmName?: string
	readonly hashValue?: string
	readonly saltValue?: string
	readonly spinCount?: number
	readonly legacy?: string
}

declare module "../../sheet/protocol" {
	interface SheetCommandMap {
		// Protects the sheet: what stays allowed, and the password's hash (none: protected without a password).
		"sheet.protect": { readonly sheet: SheetId; readonly allows: readonly SheetProtectedAction[]; readonly hash?: SheetPasswordHash }
		// The app checked the password first (protectionPassword).
		"sheet.unprotect": { readonly sheet: SheetId }
		"workbook.protect": { readonly structure: boolean; readonly windows: boolean; readonly hash?: SheetPasswordHash }
		"workbook.unprotect": object
	}

	interface SheetQueryMap {
		// The password hash protecting a sheet, the workbook or the file's password to modify; null without one.
		"protection.hash": {
			request: { readonly target: { readonly sheet: SheetId } | "workbook" | "fileSharing" }
			result: SheetPasswordHash | null
		}
	}
}

// The actions Excel's "Protect Sheet" allows unless the user changes them: selecting locked and unlocked cells.
export const DEFAULT_SHEET_ALLOWS: readonly SheetProtectedAction[] = ["selectLockedCells", "selectUnlockedCells"]

const HEX = /^[0-9A-Fa-f]{1,4}$/

// The legacy verifier of a password as Excel writes it, 4 upper-case hex digits ("" for none):
// CreatePasswordVerifier_Method1 ([MS-OFFCRYPTO] §2.3.7.1) over the password's single bytes (each UTF-16 unit's low
// byte, its high byte when the low one is 0: §2.3.7.4), the length first, taken in reverse.
export function legacySheetPassword(password: string): string {
	if (password === "") return ""

	let verifier = 0

	for (let k = password.length; k >= 0; k--) {
		const unit = k === 0 ? password.length & 0xff : password.charCodeAt(k - 1)
		const byte = k === 0 ? unit : (unit & 0xff) !== 0 ? unit & 0xff : unit >> 8

		verifier = ((((verifier & 0x4000) === 0 ? 0 : 1) | ((verifier << 1) & 0x7fff)) ^ byte) & 0xffff
	}

	return (verifier ^ 0xce4b).toString(16).toUpperCase().padStart(4, "0")
}

// How a password is checked against a hash: at once (the legacy verifier: true or false), or on the platform with
// the modern hash (dom/protection.ts verifyProtectionPassword with these fields). Null: no password is needed.
export type SheetPasswordCheck =
	| { readonly kind: "none" }
	| { readonly kind: "legacy"; readonly correct: boolean }
	| { readonly kind: "modern"; readonly algorithm: string; readonly hash: string; readonly salt: string; readonly spinCount: number }

export function sheetPasswordCheck(hash: SheetPasswordHash | null, password: string): SheetPasswordCheck {
	if (hash === null) return { kind: "none" }

	// Excel checks the modern hash when both are written.
	if (hash.hashValue !== undefined && hash.hashValue !== "")
		return {
			kind: "modern",
			algorithm: (hash.algorithmName ?? "").trim().toUpperCase(),
			hash: hash.hashValue,
			salt: hash.saltValue ?? "",
			spinCount: hash.spinCount ?? 0
		}

	if (hash.legacy === undefined || hash.legacy === "") return { kind: "none" }
	if (!HEX.test(hash.legacy)) return { kind: "legacy", correct: false }

	return { kind: "legacy", correct: Number.parseInt(hash.legacy, 16) === Number.parseInt(legacySheetPassword(password) || "0", 16) }
}

function plainHash(hash: SheetPasswordHash | undefined): XlsxProtectionHash {
	if (hash === undefined) return {}

	const out: { -readonly [K in keyof XlsxProtectionHash]: XlsxProtectionHash[K] } = {}

	if (hash.legacy !== undefined && HEX.test(hash.legacy)) out.legacy = hash.legacy.toUpperCase().padStart(4, "0")
	if (hash.hashValue !== undefined && hash.algorithmName !== undefined) {
		out.algorithmName = hash.algorithmName
		out.hashValue = hash.hashValue
		out.saltValue = hash.saltValue ?? ""
		out.spinCount = Math.max(0, Math.floor(hash.spinCount ?? 0))
	}

	return out
}

function hashOrNull(hash: XlsxProtectionHash | undefined): SheetPasswordHash | null {
	if (hash === undefined) return null

	const has = (hash.hashValue !== undefined && hash.hashValue !== "") || (hash.legacy !== undefined && hash.legacy !== "")

	return has ? { ...hash } : null
}

async function protectSheet(
	document: XlsxDocument,
	sheet: SheetId,
	protection: XlsxSheetProtection | null,
	changes: SheetChangeSink
): Promise<SheetHandled> {
	const entry = document.entry(sheet)

	if (entry === undefined || entry.kind !== "worksheet") return { refused: { reason: "unsupported", detail: "sheet" } }

	const model = await document.ready(sheet)
	const before = model.protection

	if (before === null && protection === null) return null
	// Its settings change only once it is unprotected, as in Excel.
	if (before !== null && protection !== null) return { refused: { reason: "protectedSheet" } }

	const set = (value: XlsxSheetProtection | null, sink: SheetChangeSink): void => {
		model.protection = value
		document.workbook.changes.sheetSection(sheet, "sheetProtection")
		sink.layout(sheet)
		// Locked cells show as locked, or no longer.
		sink.look(sheet, { startRow: 0, startCol: 0, endRow: SHEET_MAX_ROWS - 1, endCol: SHEET_MAX_COLS - 1 })
	}

	set(protection, changes)

	return { bytes: 256, undo: sink => set(before, sink), redo: sink => set(protection, sink) }
}

// The workbook's protection element also locks revisions (lockRevision): taken off, the element stays for it.
function locksRevisions(document: XlsxDocument): boolean {
	const section = document.workbook.workbookSections.find(candidate => candidate.name === "workbookProtection")
	const bytes = section?.bytes ?? null

	return bytes !== null && /\slockRevision\s*=\s*["'](?:1|true)["']/.test(decodeUtf8(bytes))
}

function protectWorkbook(document: XlsxDocument, protection: XlsxWorkbookProtection | null, changes: SheetChangeSink): SheetHandled {
	const workbook = document.workbook
	const before = workbook.protection
	const after = protection === null && locksRevisions(document) ? { structure: false, windows: false, hash: {} } : protection

	if (before === null && after === null) return null
	if (protection !== null && (before?.structure === true || before?.windows === true)) return { refused: { reason: "protectedWorkbook" } }

	const set = (value: XlsxWorkbookProtection | null, sink: SheetChangeSink): void => {
		workbook.protection = value
		workbook.changes.workbookSection("workbookProtection")
		sink.sheets()
	}

	set(after, changes)

	return { bytes: 128, undo: sink => set(before, sink), redo: sink => set(after, sink) }
}

export const protectionFeature = defineSheetFeature<XlsxDocument>({
	id: "protection",
	commands: {
		"sheet.protect": {
			info: { write: true },
			run: (context, command) =>
				protectSheet(
					context.doc,
					command.sheet,
					{ hash: plainHash(command.hash), allows: new Set(command.allows) },
					context.changes
				)
		},
		"sheet.unprotect": {
			info: { write: true },
			run: (context, command) => protectSheet(context.doc, command.sheet, null, context.changes)
		},
		"workbook.protect": {
			info: { write: true },
			run: (context, command) =>
				protectWorkbook(
					context.doc,
					{ structure: command.structure, windows: command.windows, hash: plainHash(command.hash) },
					context.changes
				)
		},
		"workbook.unprotect": {
			info: { write: true },
			run: context => protectWorkbook(context.doc, null, context.changes)
		}
	},
	queries: {
		"protection.hash": {
			run: async (context, request) => {
				const target = request.target

				if (target === "workbook") return hashOrNull(context.doc.workbook.protection?.hash)
				if (target === "fileSharing") return hashOrNull(context.doc.workbook.fileSharing?.hash)

				const model = await context.doc.ready(target.sheet)

				return hashOrNull(model.protection?.hash)
			}
		}
	}
})
