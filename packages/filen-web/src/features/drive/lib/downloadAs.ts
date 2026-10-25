import { toast } from "sonner"
import { driveItemName, isAbortError } from "@filen/shared"
import { isCompoundFile } from "@filen/office/core/cfb"
import { bytesSource } from "@filen/office/core/opc"
import type { SheetFileKind, SheetLockedFile, SheetOpened } from "@filen/office/core/sheet"
import type { DocxConvertedDocument, DocxEncryptionRefusal, DocxLegacyRefusal, DocxUnlockedDocument } from "@filen/office/dom/docx"
import type { DocxPdfProgress } from "@filen/office/dom/docx/pdfClient"
import { recordContentVerdict } from "@/features/drive/lib/contentVerdicts"
import { driveItemMime, type DriveItem } from "@/features/drive/lib/item"
import { narrowToAnyFile } from "@/features/drive/lib/download"
import { extensionOf, itemTypeExtension } from "@/features/drive/lib/preview.logic"
import {
	DOWNLOAD_AS_TARGETS,
	downloadAsFormat,
	downloadAsSource,
	type DownloadAsFormat,
	type DownloadAsTarget
} from "@/features/drive/lib/downloadAs.logic"
import { askPassword, type DownloadAsPasswordPurpose } from "@/features/drive/lib/downloadAsPassword"
import { writeZipOf, zipDelivery, zipEntryNamer, type ZipDelivery, type ZipFile } from "@/features/drive/lib/downloadAsZip"
import { isPickerCancelled } from "@/features/drive/lib/saveDownload"
import { pdfPasswordAllowed } from "@/features/office/lib/pdfPassword"
import {
	docxRefusalKey,
	docxFormatOf,
	isTextTemplate,
	legacyNeedsPassword,
	legacyRefusalKey
} from "@/features/preview/components/docxViewer.logic"
import { docxConvert, docxLegacy, docxProtection, docxRtf } from "@/features/preview/lib/docxEngine"
import { docxPdfFailure, makeDocxPdf, reportDocxPdf, type DocxPdfSource } from "@/features/preview/lib/docxPdf"
import { pdfProgressText } from "@/features/preview/lib/docxPdf.logic"
import type { EditedFile } from "@/features/preview/lib/docxLiveFile"
import type { PreviewAccessMode } from "@/features/preview/lib/accessMode"
import { joinPreviewBytes } from "@/features/preview/lib/previewCache"
import { isTextSheetKind, openSheet, textToXlsx } from "@/features/spreadsheet/lib/sheetHosts"
import { SheetEventRelay } from "@/features/spreadsheet/lib/sheetEvents"
import { withWorkbookDigit } from "@/features/spreadsheet/lib/sheetDigitWidth"
import { isLegacySheetKind, sheetKindOf } from "@/features/spreadsheet/lib/sheetKind"
import { browserLanguage, sheetLocaleOf } from "@/features/spreadsheet/formulaBar/sheetLocale"
import { formOf, pdfFile, pdfRequest, printRequests } from "@/features/spreadsheet/print/print.logic"
import { sheetSettings } from "@/features/spreadsheet/print/printSettings"
import { makeSheetPdf, sheetPdfMessages } from "@/features/spreadsheet/save/sheetPdf"
import { fileStem } from "@/features/spreadsheet/save/sheetSave.logic"
import { runOp } from "@/lib/actions/outcome"
import { downloadBlob } from "@/lib/downloadBlob"
import { i18n, type DriveKey, type PreviewKey } from "@/lib/i18n"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { log } from "@/lib/log"
import { asErrorDTO } from "@/lib/sdk/errors"
import { sdkApi } from "@/lib/sdk/client"

// Download as from the item menus: each file exported from its saved bytes without opening its viewer, one after
// another under one toast whose Cancel stops the download and the worker job in flight (and skips the rest). Several
// files come as one zip, as the drive's Download delivers them, and what went wrong is told once, after the run. The
// bytes come as the viewer's do (an open preview's buffer is reused, else one streamed read of the file); the work
// runs where the viewers' does: the document engine's worker converts Word 97–2003 and RTF files and unlocks
// protected ones, the PDF worker lays the document out (ended with the export), the sheet worker opens the workbook
// and prints it (released once idle). A protected file asks its password first, which then protects the PDF. What
// comes out equals the editors' File menu export of the same saved file.

// A workbook converted from the session its viewer holds open (in the workbook worker, unsaved edits included).
export type LiveConversion = (format: "xlsx" | "ods", signal: AbortSignal) => Promise<LiveAnswer>

type LiveAnswer =
	| { readonly ok: true; readonly bytes: Uint8Array; readonly lossy: readonly LossyFeature[] }
	| { readonly ok: false; readonly reason: string; readonly message: string }

interface LossyFeature {
	readonly kind: string
	readonly count: number
}

// The document editor's document as it holds it now (docxLiveFile.ts): in the file's own format, or already converted.
export type LiveFile = (target: "docx" | "odt", signal: AbortSignal) => Promise<EditedFile>

// Where the menu was opened: a public link's files are read as the viewer reads them there; an editor's open
// workbook converts from its session (`live`), an editor's open document from what it holds (`liveFile`).
export interface DownloadAsContext {
	readonly accessMode: PreviewAccessMode
	readonly cacheScope: string | null
	readonly live?: LiveConversion
	readonly liveFile?: LiveFile
}

type Message =
	| { readonly key: `preview:${PreviewKey}` | `drive:${DriveKey}`; readonly values: Readonly<Record<string, number>> }
	// Already in words (an error's own label).
	| { readonly text: string }

type Exported =
	| { readonly kind: "file"; readonly blob: Blob; readonly warnings: readonly Message[] }
	| { readonly kind: "failed"; readonly error: Message }
	// The user let the password prompt go: nothing to report.
	| { readonly kind: "skipped" }

type Phase =
	| { readonly kind: "downloading" }
	| { readonly kind: "converting" }
	| { readonly kind: "document"; readonly progress: DocxPdfProgress | null }
	| { readonly kind: "sheet"; readonly done: number | null; readonly total: number }

interface Run {
	readonly signal: AbortSignal
	readonly show: (phase: Phase) => void
}

class Aborted extends Error {
	constructor() {
		super("Download as was cancelled")
		this.name = "AbortError"
	}
}

function failed(key: PreviewKey, values: Readonly<Record<string, number>> = {}): Exported {
	return { kind: "failed", error: { key: `preview:${key}`, values } }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		return Promise.reject(new Aborted())
	}

	return new Promise((resolve, reject) => {
		const onAbort = (): void => {
			reject(new Aborted())
		}

		signal.addEventListener("abort", onAbort, { once: true })
		promise.then(
			value => {
				signal.removeEventListener("abort", onAbort)
				resolve(value)
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort)
				reject(error instanceof Error ? error : new Error(String(error)))
			}
		)
	})
}

// The file's bytes: a buffer the preview already holds or is loading (shared: `owned` false, copied before it is
// handed to a worker), else a read of its own, cancelled with the export.
async function fileBytes(item: DriveItem, context: DownloadAsContext, signal: AbortSignal): Promise<{ bytes: Uint8Array; owned: boolean }> {
	const joined = await abortable(joinPreviewBytes(context.cacheScope, item.data.uuid), signal)

	if (joined !== undefined) {
		return { bytes: joined, owned: false }
	}

	const file = narrowToAnyFile(item)
	const token = crypto.randomUUID()
	const cancel = (): void => {
		void sdkApi.cancelPreviewDownload(token)
	}

	signal.addEventListener("abort", cancel, { once: true })

	try {
		const bytes = await runOp(
			context.accessMode === "anon" ? sdkApi.downloadLinkedFileBytesAnon(file, token) : sdkApi.downloadFileBytes(file, token)
		)

		if (signal.aborted) {
			throw new Aborted()
		}

		return { bytes, owned: true }
	} finally {
		signal.removeEventListener("abort", cancel)
	}
}

async function documentPdf(source: DocxPdfSource, name: string, run: Run, password?: string): Promise<Exported> {
	run.show({ kind: "document", progress: null })

	try {
		const result = await makeDocxPdf(source, name, {
			signal: run.signal,
			password,
			onProgress: progress => {
				run.show({ kind: "document", progress })
			}
		})
		const warning = reportDocxPdf(result)

		return { kind: "file", blob: result.blob as Blob, warnings: warning === null ? [] : [{ key: `preview:${warning}`, values: {} }] }
	} catch (error) {
		const key = docxPdfFailure(error, run.signal.aborted)

		if (key === null) {
			throw new Aborted()
		}

		return failed(key)
	}
}

// A Word 97–2003 document's package, converted in the document engine's worker (taken, then dropped there).
async function convertedPackage(document: DocxConvertedDocument, signal: AbortSignal): Promise<Uint8Array> {
	try {
		return await document.take({ signal })
	} finally {
		document.release()
	}
}

// What a password check in the worker found: opened (`value`, which the caller releases if it goes unused), a wrong
// password, a cancelled check, or a file no password opens (`refusal`).
type Checked<T, R> =
	| { readonly kind: "opened"; readonly value: T }
	| { readonly kind: "wrong" }
	| { readonly kind: "aborted" }
	| { readonly kind: "refused"; readonly refusal: R }

type Prompted<T, R> =
	| { readonly kind: "accepted"; readonly value: T; readonly password: string }
	// "password": the password verified as typed, but a PDF cannot be protected with it (SASLprep), checked first.
	| { readonly kind: "refused"; readonly refusal: R | "password" }
	| { readonly kind: "skipped" }

// Asks for the file's password (the shared prompt) until `check` opens the file with one; the password then protects
// the PDF. A password the PDF cannot take is refused before any work starts, as in the editors' prompts.
async function promptFor<T, R>(
	name: string,
	run: Run,
	check: (password: string, signal: AbortSignal) => Promise<Checked<T, R>>,
	release: (value: T) => void,
	// What is held for the locked file, let go unless it opened (then it goes with what opened).
	dispose: () => void,
	// "copy": the password protects a converted copy, which takes any password the file opens with.
	options: { readonly purpose?: DownloadAsPasswordPurpose } = {}
): Promise<Prompted<T, R>> {
	const purpose = options.purpose ?? "pdf"
	const state: { found: { value: T; password: string } | null; refusal: R | "password" | null } = { found: null, refusal: null }
	const accepted = await askPassword(
		name,
		async (typed, signal) => {
			if (purpose === "pdf" && !pdfPasswordAllowed(typed)) {
				state.refusal = "password"

				return "refused"
			}

			const answer = await check(typed, signal)

			switch (answer.kind) {
				case "wrong":
				case "aborted":
					return answer.kind
				case "refused":
					state.refusal = answer.refusal

					return "refused"
				case "opened":
					// The prompt or the export went while the check finished: nothing is exported.
					if (signal.aborted || run.signal.aborted) {
						release(answer.value)

						return "aborted"
					}

					state.found = { value: answer.value, password: typed }

					return "accepted"
			}
		},
		run.signal,
		purpose
	)

	if (accepted && state.found !== null) {
		return { kind: "accepted", ...state.found }
	}

	dispose()

	if (state.refusal !== null) {
		return { kind: "refused", refusal: state.refusal }
	}

	if (run.signal.aborted) {
		throw new Aborted()
	}

	return { kind: "skipped" }
}

// A Word 97–2003 document, converted in the document engine's worker as the viewer converts it (an encrypted one
// converted again with its password, each try).
async function legacyPdf(bytes: Uint8Array, name: string, run: Run): Promise<Exported> {
	const opened = await docxLegacy.open(bytesSource(bytes), { signal: run.signal })

	if (opened.kind === "aborted") {
		throw new Aborted()
	}

	if (opened.kind === "converted") {
		return documentPdf({ kind: "file", bytes: await convertedPackage(opened.document, run.signal), owned: true }, name, run)
	}

	if (!legacyNeedsPassword(opened.refusal)) {
		return failed(legacyRefusalKey(opened.refusal))
	}

	const prompted = await promptFor<DocxConvertedDocument, DocxLegacyRefusal>(
		name,
		run,
		async (password, signal) => {
			const answer = await docxLegacy.open(bytesSource(bytes), { signal, password })

			if (answer.kind === "converted") {
				return { kind: "opened", value: answer.document }
			}

			if (answer.kind === "aborted") {
				return { kind: "aborted" }
			}

			return answer.refusal.reason === "wrongPassword" ? { kind: "wrong" } : { kind: "refused", refusal: answer.refusal }
		},
		document => {
			document.release()
		},
		() => undefined
	)

	switch (prompted.kind) {
		case "accepted":
			return documentPdf(
				{ kind: "file", bytes: await convertedPackage(prompted.value, run.signal), owned: true },
				name,
				run,
				prompted.password
			)
		case "refused":
			return failed(prompted.refusal === "password" ? "previewDocxPdfPasswordUnsupported" : legacyRefusalKey(prompted.refusal))
		case "skipped":
			return prompted
	}
}

// A document laid out as its viewer lays it out (docxViewer.tsx): an RTF file read into its package, a compound
// file probed for a password (then unlocked) or converted as a Word 97–2003 document, anything else as it is.
async function exportDocument(item: DriveItem, bytes: Uint8Array, owned: boolean, context: DownloadAsContext, run: Run): Promise<Exported> {
	const name = driveItemName(item)
	const format = docxFormatOf(name)

	// A `.dot` the drive could not yet tell apart, read here as its viewer reads it: a text file is no document. What
	// it is is recorded as the viewer records it, so the menus stop offering it.
	if (isTextTemplate(item, bytes)) {
		recordContentVerdict({ uuid: item.data.uuid, name, mime: driveItemMime(item), size: item.data.size }, "notWordBinary", {
			memoryOnly: context.accessMode === "anon"
		})

		return { kind: "failed", error: { key: "drive:driveDownloadAsNotDocument", values: {} } }
	}

	run.show({ kind: "document", progress: null })

	if (format === "rtf") {
		const opened = await docxRtf.open(bytes, { signal: run.signal })

		if (opened.kind === "aborted") {
			throw new Aborted()
		}

		if (opened.kind === "notRtf") {
			return failed("previewDocxPdfFailed")
		}

		let docx: Uint8Array
		// What the file shows that its package leaves out (an equation): the PDF's report counts it.
		const untranslated = opened.document.untranslated

		try {
			docx = await opened.document.take()
		} finally {
			opened.document.release()
		}

		return documentPdf({ kind: "file", bytes: docx, owned: true, untranslated }, name, run)
	}

	if (!isCompoundFile(bytes)) {
		return documentPdf({ kind: "file", bytes, format, owned }, name, run)
	}

	const probed = await docxProtection.open(bytesSource(bytes), { signal: run.signal })

	switch (probed.kind) {
		case "aborted":
			throw new Aborted()
		case "refused":
			return failed(docxRefusalKey(probed.reason))
		case "plain":
			return legacyPdf(bytes, name, run)
		case "needsPassword":
			break
	}

	const locked = probed.locked
	const prompted = await promptFor<DocxUnlockedDocument, DocxEncryptionRefusal>(
		name,
		run,
		async (password, signal) => {
			const result = await locked.unlock(password, { signal })

			if (result.ok) {
				return { kind: "opened", value: result.document }
			}

			return result.reason === "wrongPassword" || result.reason === "aborted"
				? { kind: result.reason === "wrongPassword" ? "wrong" : "aborted" }
				: { kind: "refused", refusal: result.reason }
		},
		document => {
			document.release()
		},
		() => {
			locked.dispose()
		}
	)

	switch (prompted.kind) {
		case "accepted":
			return documentPdf({ kind: "unlocked", document: prompted.value }, name, run, prompted.password)
		case "refused":
			return failed(prompted.refusal === "password" ? "previewDocxPdfPasswordUnsupported" : docxRefusalKey(prompted.refusal))
		case "skipped":
			return prompted
	}
}

// The workbook opened in its sheet worker as its viewer opens it (useSheetSession.ts), its active sheet printed as
// the File menu's Download as ▸ PDF prints it (sheetBody.tsx) once the viewer opened it.
async function exportSpreadsheet(item: DriveItem, bytes: Uint8Array, owned: boolean, name: string, run: Run): Promise<Exported> {
	const { kind } = sheetKindOf(extensionOf(name), bytes, itemTypeExtension(item) === "tsv")
	const events = new SheetEventRelay()

	run.show({ kind: "sheet", done: null, total: 0 })

	const opened = await openSheet(owned ? bytes : bytes.slice(), { kind, signal: run.signal }, events.emit)

	switch (opened.kind) {
		case "aborted":
			throw new Aborted()
		case "failed":
			return failed("previewSpreadsheetUnreadable")
		case "refused":
			return failed(docxRefusalKey(opened.reason))
		case "opened":
			return printWorkbook(opened, events, kind, name, run)
		case "needsPassword":
			break
	}

	const locked = opened.locked
	const prompted = await promptFor<SheetOpened, DocxEncryptionRefusal>(
		name,
		run,
		async (password, signal) => {
			const answer = await locked.unlock(password, { signal }).catch(() => null)

			if (answer === null) {
				return { kind: "aborted" }
			}

			if (answer.ok) {
				return { kind: "opened", value: answer }
			}

			return answer.reason === "wrongPassword" || answer.reason === "aborted"
				? { kind: answer.reason === "wrongPassword" ? "wrong" : "aborted" }
				: { kind: "refused", refusal: answer.reason }
		},
		workbook => {
			workbook.session.close()
		},
		() => {
			locked.dispose()
		}
	)

	switch (prompted.kind) {
		case "accepted":
			return printWorkbook(prompted.value, events, kind, name, run, prompted.password)
		case "refused":
			return failed(prompted.refusal === "password" ? "previewSheetPdfPasswordUnsupported" : docxRefusalKey(prompted.refusal))
		case "skipped":
			return prompted
	}
}

async function printWorkbook(
	opened: SheetOpened,
	events: SheetEventRelay,
	kind: SheetFileKind,
	name: string,
	run: Run,
	password?: string
): Promise<Exported> {
	const { session } = opened

	try {
		const { info } = await withWorkbookDigit(opened, events)

		// The locale the viewer's grid has its session show numbers and dates in (useSheetFormula.tsx).
		session.configure({ locale: sheetLocaleOf(browserLanguage()) })
		const sheet = info.sheets.find(entry => entry.id === info.activeSheet)
		const active = sheet === undefined ? null : await sheetSettings({ session, layout: () => null }, kind, sheet)

		if (active === null) {
			return failed("previewSheetPdfNothing")
		}

		const requests = printRequests(formOf(active.setup), active, [active], []) ?? []
		const request = pdfRequest(requests, pdfFile(name, info, browserLanguage()), {
			kind,
			sheets: info.sheets,
			date1904: info.date1904,
			showFormulas: false
		})
		const result = await makeSheetPdf(session, request, {
			signal: run.signal,
			password,
			onProgress: (done, total) => {
				run.show({ kind: "sheet", done, total })
			}
		})

		if (run.signal.aborted) {
			throw new Aborted()
		}

		const { warnings, error } = sheetPdfMessages(result)

		if (result.ok) {
			return {
				kind: "file",
				blob: result.blob,
				warnings: warnings.map(warning => ({ key: `preview:${warning.key}` as const, values: warning.values }))
			}
		}

		return failed(error?.key ?? "previewSheetPdfFailed", error?.values ?? {})
	} catch (error) {
		if (run.signal.aborted) {
			throw new Aborted()
		}

		log.error("preview", "spreadsheet pdf failed", error)

		return failed("previewSheetPdfFailed")
	} finally {
		session.close()
	}
}

function phaseText(phase: Phase): string {
	switch (phase.kind) {
		case "downloading":
			return i18n.t("drive:driveDownloadAsDownloading")
		case "converting":
			return i18n.t("drive:driveDownloadAsConverting")
		case "document": {
			const text = pdfProgressText(phase.progress)

			return text.key === "previewDocxPdfProgress"
				? i18n.t("preview:previewDocxPdfProgress", { done: text.done, total: text.total })
				: i18n.t("preview:previewDocxPdfPreparing")
		}
		case "sheet":
			return phase.done === null
				? i18n.t("preview:previewSheetPdfPreparing")
				: i18n.t("preview:previewSheetPdfProgress", { done: phase.done, total: phase.total })
	}
}

async function exportOne(item: DriveItem, target: DownloadAsTarget, context: DownloadAsContext, run: Run): Promise<Exported> {
	const source = downloadAsSource(item)
	const format = downloadAsFormat(item)

	if (source === null || (target !== "pdf" && (format === null || !DOWNLOAD_AS_TARGETS[target].from.has(format)))) {
		return target === "pdf" ? failed("previewDocxPdfFailed") : convertFailed("driveDownloadAsConvertFailed")
	}

	const name = driveItemName(item)

	if (source === "spreadsheet" && (target === "xlsx" || target === "ods") && context.live !== undefined) {
		run.show({ kind: "converting" })

		const answer = await abortable(context.live(target, run.signal), run.signal)

		if (run.signal.aborted) {
			throw new Aborted()
		}

		// The cell being typed could not be committed: the sheet said why (sheetConvert.ts commitForExport).
		if (!answer.ok && answer.reason === "uncommitted") {
			return { kind: "skipped" }
		}

		return sheetConverted(answer, target)
	}

	if (source === "document" && (target === "docx" || target === "odt") && format !== null && context.liveFile !== undefined) {
		run.show({ kind: "converting" })

		let edited: EditedFile

		try {
			edited = await abortable(context.liveFile(target, run.signal), run.signal)
		} catch (error) {
			if (run.signal.aborted) {
				throw new Aborted()
			}

			log.error("drive", "download as could not write the edited document", error)

			return convertFailed("driveDownloadAsConvertFailed")
		}

		// Nothing written (no unsaved edit, or a view-only document): the saved file converts below.
		if (edited.kind === "converted") {
			return documentConverted(edited.conversion, target)
		}

		if (edited.kind === "file") {
			return convertDocument(item, edited.bytes, true, edited.format ?? format, target, context, run, edited.lossy)
		}
	}

	run.show({ kind: "downloading" })

	const { bytes, owned } = await fileBytes(item, context, run.signal)

	if (target === "pdf" || format === null) {
		return source === "document" ? exportDocument(item, bytes, owned, context, run) : exportSpreadsheet(item, bytes, owned, name, run)
	}

	return target === "docx" || target === "odt"
		? convertDocument(item, bytes, owned, format, target, context, run)
		: convertSpreadsheet(item, bytes, owned, name, target, run)
}

const CONVERTED_TYPES: Readonly<Record<Exclude<DownloadAsTarget, "pdf">, string>> = {
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	odt: "application/vnd.oasis.opendocument.text",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	ods: "application/vnd.oasis.opendocument.spreadsheet"
}

function convertFailed(key: DriveKey): Exported {
	return { kind: "failed", error: { key: `drive:${key}`, values: {} } }
}

// What a converted copy lacks, told once per kind of loss: formulas by count, the rest together. A workbook read as
// its values alone (Excel 97–2003) says so as Save as .xlsx does, which covers the rest.
function lossyWarnings(lossy: readonly LossyFeature[]): Message[] {
	if (lossy.some(feature => feature.kind === "valuesOnly")) {
		return [{ key: "drive:driveDownloadAsConvertValuesOnly", values: {} }]
	}

	const formulas = lossy.reduce((sum, feature) => sum + (feature.kind === "formula" ? feature.count : 0), 0)
	const warnings: Message[] = []

	if (formulas > 0) {
		warnings.push({ text: i18n.t("drive:driveDownloadAsConvertFormulas", { count: formulas }) })
	}

	if (lossy.some(feature => feature.kind !== "formula" && feature.count > 0)) {
		warnings.push({ key: "drive:driveDownloadAsConvertLossy", values: {} })
	}

	return warnings
}

function convertedFile(bytes: Uint8Array, target: Exclude<DownloadAsTarget, "pdf">, lossy: readonly LossyFeature[]): Exported {
	return {
		kind: "file",
		blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: CONVERTED_TYPES[target] }),
		warnings: lossyWarnings(lossy)
	}
}

// A text document converted in the document engine's worker (an RTF or Word 97–2003 file read there too). A
// password-protected file is refused: its copy could not keep the protection.
async function convertDocument(
	item: DriveItem,
	bytes: Uint8Array,
	owned: boolean,
	format: DownloadAsFormat,
	target: "docx" | "odt",
	context: DownloadAsContext,
	run: Run,
	// What an earlier step lacked (an edited document converted to .docx where it is held), joined to this report.
	earlier: readonly LossyFeature[] = []
): Promise<Exported> {
	const name = driveItemName(item)

	if (isTextTemplate(item, bytes)) {
		recordContentVerdict({ uuid: item.data.uuid, name, mime: driveItemMime(item), size: item.data.size }, "notWordBinary", {
			memoryOnly: context.accessMode === "anon"
		})

		return { kind: "failed", error: { key: "drive:driveDownloadAsNotDocument", values: {} } }
	}

	if (format !== "docx" && format !== "odt" && format !== "rtf" && format !== "doc") {
		return convertFailed("driveDownloadAsConvertFailed")
	}

	run.show({ kind: "converting" })

	// A Word 97–2003 file may be read again with its password: the caller's buffer is never handed over for it.
	const converted = await docxConvert.convert(bytes, format, target, { signal: run.signal, owned: owned && format !== "doc" })

	if (converted.kind === "refused" && converted.reason === "encrypted" && format === "doc" && target === "docx") {
		return protectedDocx(bytes, name, run, converted.encryption)
	}

	return documentConverted(converted, target, earlier)
}

type DocxConverted = Awaited<ReturnType<typeof docxConvert.convert>>
type DocxEncryptionScheme = Extract<DocxConverted, { kind: "refused" }>["encryption"]

function documentConverted(converted: DocxConverted, target: "docx" | "odt", earlier: readonly LossyFeature[] = []): Exported {
	switch (converted.kind) {
		case "aborted":
			throw new Aborted()
		case "converted":
			return convertedFile(converted.bytes, target, [...earlier, ...converted.lossy])
		case "refused":
			switch (converted.reason) {
				case "encrypted":
				case "wrongPassword":
					// An OpenDocument copy is never protected; a protected source to .docx is only refused when it is
					// one Filen cannot decrypt (an ODF file's, a cipher of no known kind).
					return target === "odt" ? convertFailed("driveDownloadAsConvertProtected") : failed("previewDocxUnsupportedEncryption")
				case "tooLarge":
					return convertFailed("driveDownloadAsConvertTooLarge")
				case "legacyVersion":
					return convertFailed("driveDownloadAsConvertLegacyVersion")
				case "aborted":
					throw new Aborted()
				default:
					log.error("drive", "download as conversion refused", converted.reason, converted.message)

					return convertFailed("driveDownloadAsConvertFailed")
			}
	}
}

// A password-protected .doc as a .docx protected with the same password. One that is really an encrypted Word package
// already is one: it goes as it is. A Word 97–2003 document asks its password, which the docx worker converts it with
// and seals the .docx under (the password goes with each try, nothing keeps it).
async function protectedDocx(bytes: Uint8Array, name: string, run: Run, encryption: DocxEncryptionScheme | undefined): Promise<Exported> {
	// A cipher no password opens here is refused as the viewer refuses it, before any password is asked.
	if (encryption === "unknown") {
		return failed("previewDocxUnsupportedEncryption")
	}

	// No cipher named: an encrypted Word package under a .doc name, which goes as it is.
	if (encryption === undefined) {
		const probed = await docxProtection.open(bytesSource(bytes), { signal: run.signal })

		switch (probed.kind) {
			case "aborted":
				throw new Aborted()
			case "refused":
				return failed(docxRefusalKey(probed.reason))
			case "needsPassword":
				probed.locked.dispose()

				return convertedFile(bytes.slice(), "docx", [])
			case "plain":
				return failed("previewDocxUnsupportedEncryption")
		}
	}

	const prompted = await promptFor<DocxConverted, Extract<DocxConverted, { kind: "refused" }>>(
		name,
		run,
		async (password, signal) => {
			const answer = await docxConvert.convert(bytes, "doc", "docx", { signal, password })

			switch (answer.kind) {
				case "converted":
					return { kind: "opened", value: answer }
				case "aborted":
					return { kind: "aborted" }
				case "refused":
					return answer.reason === "wrongPassword" ? { kind: "wrong" } : { kind: "refused", refusal: answer }
			}
		},
		() => undefined,
		() => undefined,
		{ purpose: "copy" }
	)

	switch (prompted.kind) {
		case "accepted":
			return documentConverted(prompted.value, "docx")
		case "refused":
			return prompted.refusal === "password"
				? convertFailed("driveDownloadAsConvertFailed")
				: documentConverted(prompted.refusal, "docx")
		case "skipped":
			return prompted
	}
}

// A spreadsheet converted in the workbook worker on a session of its own, closed once done: a workbook (Excel,
// OpenDocument, Excel 97–2003) by its session's conversion, a text file's cells made a workbook first (as Save as
// .xlsx makes it), then converted. A password-protected file is refused (its copy could not keep the protection), but
// to .xlsx from an .xls (protectedXlsx).
async function convertSpreadsheet(
	item: DriveItem,
	bytes: Uint8Array,
	owned: boolean,
	name: string,
	target: "xlsx" | "ods",
	run: Run
): Promise<Exported> {
	const { kind } = sheetKindOf(extensionOf(name), bytes, itemTypeExtension(item) === "tsv")

	run.show({ kind: "converting" })

	// An .xls that is really a password-protected workbook package already is the protected .xlsx: kept to go as it is.
	const keep = isLegacySheetKind(kind) && target === "xlsx"
	let workbook = owned && !keep ? bytes : bytes.slice()
	let workbookKind = kind

	if (isTextSheetKind(kind)) {
		const cells = await withSession(workbook, kind, run, session => session.query("saveAs.cells", {}, { signal: run.signal }))

		if (cells.kind !== "done") {
			return cells.exported
		}

		// A file with more rows than a sheet holds is read only in part: its copy would leave the rest out.
		if (!cells.value.ok) {
			return sheetConverted({ ok: false, reason: cells.value.refusal.reason, message: "The cells could not all be read" }, target)
		}

		const xlsx = await abortable(textToXlsx(cells.value.bytes, fileStem(name)), run.signal)

		if (!xlsx.ok) {
			return convertFailed("driveDownloadAsConvertFailed")
		}

		if (target === "xlsx") {
			return convertedFile(xlsx.bytes, target, [])
		}

		workbook = xlsx.bytes
		workbookKind = "xlsx"
	}

	const converted = await withSession(
		workbook,
		workbookKind,
		run,
		// An .ods takes the user's language as its default, as a new one does.
		session => session.query("saveAs.format", { format: target, language: browserLanguage() }, { signal: run.signal }),
		keep ? locked => protectedXlsx(locked, bytes, name, run) : undefined
	)

	if (converted.kind !== "done") {
		return converted.exported
	}

	return sheetConverted(converted.value, target)
}

function sheetConverted(answer: LiveAnswer, target: "xlsx" | "ods"): Exported {
	if (answer.ok) {
		return convertedFile(answer.bytes, target, answer.lossy)
	}

	switch (answer.reason) {
		case "aborted":
			throw new Aborted()
		case "encrypted":
			return convertFailed("driveDownloadAsConvertProtected")
		case "tooLarge":
			return convertFailed("driveDownloadAsConvertTooLarge")
		default:
			log.error("drive", "download as conversion refused", answer.reason, answer.message)

			return convertFailed("driveDownloadAsConvertFailed")
	}
}

// A password-protected .xls as an .xlsx protected with the same password. One that is really an encrypted workbook
// package already is one: it goes as it is. An Excel 97–2003 workbook asks its password; its session's Save as .xlsx
// seals the copy under it (the workbook worker keeps no password).
async function protectedXlsx(locked: SheetLockedFile, bytes: Uint8Array, name: string, run: Run): Promise<Exported> {
	if (locked.scheme === "standard" || locked.scheme === "agile") {
		locked.dispose()

		return convertedFile(bytes, "xlsx", [])
	}

	const prompted = await promptFor<SheetOpened, DocxEncryptionRefusal>(
		name,
		run,
		async (password, signal) => {
			const answer = await locked.unlock(password, { signal }).catch(() => null)

			if (answer === null) {
				return { kind: "aborted" }
			}

			if (answer.ok) {
				return { kind: "opened", value: answer }
			}

			return answer.reason === "wrongPassword" || answer.reason === "aborted"
				? { kind: answer.reason === "wrongPassword" ? "wrong" : "aborted" }
				: { kind: "refused", refusal: answer.reason }
		},
		workbook => {
			workbook.session.close()
		},
		() => {
			locked.dispose()
		},
		{ purpose: "copy" }
	)

	switch (prompted.kind) {
		case "accepted":
			break
		case "refused":
			return prompted.refusal === "password"
				? convertFailed("driveDownloadAsConvertFailed")
				: failed(docxRefusalKey(prompted.refusal))
		case "skipped":
			return prompted
	}

	const { session } = prompted.value

	try {
		const saved = await session.save({ signal: run.signal })

		if (run.signal.aborted) {
			throw new Aborted()
		}

		if (!saved.ok) {
			log.error("drive", "download as protected workbook save failed", saved.reason, saved.message)

			return convertFailed("driveDownloadAsConvertFailed")
		}

		// Its values alone, as every copy of an Excel 97–2003 workbook (saveAs.format's report).
		return convertedFile(saved.bytes, "xlsx", [{ kind: "valuesOnly", count: 1 }])
	} finally {
		session.close()
	}
}

type InSession<T> = { readonly kind: "done"; readonly value: T } | { readonly kind: "ended"; readonly exported: Exported }

// `task` on the file opened in its sheet worker (bytes transferred), the session closed after. A protected file is
// refused before any password is asked.
async function withSession<T>(
	bytes: Uint8Array,
	kind: SheetFileKind,
	run: Run,
	task: (session: SheetOpened["session"]) => Promise<T>,
	// What a password-protected file gives instead, given what holds it (else it is refused: an OpenDocument copy could
	// not be protected).
	onLocked?: (locked: SheetLockedFile) => Promise<Exported>
): Promise<InSession<T>> {
	const opened = await openSheet(bytes, { kind, signal: run.signal }, () => undefined)

	switch (opened.kind) {
		case "aborted":
			throw new Aborted()
		case "failed":
			return { kind: "ended", exported: failed("previewSpreadsheetUnreadable") }
		case "refused":
			return { kind: "ended", exported: failed(docxRefusalKey(opened.reason)) }
		case "needsPassword":
			if (onLocked !== undefined) {
				return { kind: "ended", exported: await onLocked(opened.locked) }
			}

			opened.locked.dispose()

			return { kind: "ended", exported: convertFailed("driveDownloadAsConvertProtected") }
		case "opened":
			break
	}

	try {
		const value = await task(opened.session)

		if (run.signal.aborted) {
			throw new Aborted()
		}

		return { kind: "done", value }
	} finally {
		opened.session.close()
	}
}

let runs = 0

// What a run tells of one file once it ends: why it gave no PDF, or what its PDF lacks (never the PDF itself, which
// a bulk run lets go once written).
interface Outcome {
	readonly name: string
	readonly failed: Message | null
	readonly warnings: readonly Message[]
}

// Files a bulk run's report names, the rest counted.
const REPORT_LINES = 5

function messageText(message: Message): string {
	return "text" in message ? message.text : i18n.t(message.key, message.values)
}

// One report for a bulk run: the files that failed (else those whose PDF lacks something), each with why.
function reportBulk(outcomes: readonly Outcome[]): void {
	const failed = outcomes.filter(outcome => outcome.failed !== null)
	const warned = outcomes.filter(outcome => outcome.warnings.length > 0)
	const listed = [...failed, ...warned]

	if (listed.length === 0) {
		return
	}

	const lines = listed
		.slice(0, REPORT_LINES)
		.map(({ name, failed: error, warnings }) => `${name}: ${(error === null ? warnings : [error]).map(messageText).join(" ")}`)

	if (listed.length > REPORT_LINES) {
		lines.push(i18n.t("drive:driveDownloadAsReportMore", { count: listed.length - REPORT_LINES }))
	}

	const options = { description: lines.join("\n"), classNames: { description: "whitespace-pre-line" } }

	if (failed.length > 0) {
		toast.error(i18n.t("drive:driveDownloadAsReportFailed", { count: failed.length, total: outcomes.length }), options)
	} else {
		toast.warning(i18n.t("drive:driveDownloadAsReportWarned", { count: warned.length }), options)
	}
}

interface Exports {
	readonly signal: AbortSignal
	readonly id: string
	readonly action: { readonly label: string; readonly onClick: () => void }
	readonly outcomes: Outcome[]
}

// Read through a call: an earlier check would narrow the flag for the rest of the turn.
function cancelled(signal: AbortSignal): boolean {
	return signal.aborted
}

// Exports `items` one after another under the run's toast, each file's PDF handed out as it is made (the next file
// is started once the caller asks for it); what became of each goes to `outcomes`. Ends early once cancelled.
async function* exportFiles(
	items: readonly DriveItem[],
	target: DownloadAsTarget,
	context: DownloadAsContext,
	run: Exports
): AsyncGenerator<{ name: string; blob: Blob }> {
	for (const [index, item] of items.entries()) {
		if (run.signal.aborted) {
			return
		}

		const name = driveItemName(item)
		const description =
			items.length > 1 ? i18n.t("drive:driveDownloadAsBulkItem", { name, index: index + 1, count: items.length }) : name
		let exported: Exported

		try {
			exported = await exportOne(item, target, context, {
				signal: run.signal,
				show: phase => {
					toast.loading(phaseText(phase), { id: run.id, action: run.action, description, duration: Number.POSITIVE_INFINITY })
				}
			})
		} catch (error) {
			if (cancelled(run.signal)) {
				return
			}

			log.error("drive", "download as failed", error)
			exported = {
				kind: "failed",
				error:
					error instanceof Error
						? target === "pdf"
							? { key: "preview:previewDocxPdfFailed", values: {} }
							: { key: "drive:driveDownloadAsConvertFailed", values: {} }
						: { text: errorLabel(error) }
			}
		}

		switch (exported.kind) {
			case "file":
				run.outcomes.push({ name, failed: null, warnings: exported.warnings })
				yield { name, blob: exported.blob }
				break
			case "failed":
				run.outcomes.push({ name, failed: exported.error, warnings: [] })
				break
			case "skipped":
				break
		}
	}
}

// Exports `items` to `target` one after another; one file downloads as "<name>.<extension>", several as one zip of
// them, saved as the drive's Download saves several files. Call it synchronously off the click (the save picker
// needs the gesture). Resolves once done, failed or cancelled; never rejects.
export async function startDownloadAs(items: readonly DriveItem[], target: DownloadAsTarget, context: DownloadAsContext): Promise<void> {
	const controller = new AbortController()
	const cancel = (): void => {
		controller.abort()
	}
	const run: Exports = {
		signal: controller.signal,
		id: `download-as-${String(++runs)}`,
		action: { label: i18n.t("preview:previewDocxPdfCancel"), onClick: cancel },
		outcomes: []
	}
	const extension = DOWNLOAD_AS_TARGETS[target].extension
	// Asked first, while the click still counts as one.
	// The archive's download ended before the archive did: the browser's own Cancel ends the run as the toast's
	// does; anything else (a failed or stalled download) ends it with why.
	const onEnded = (error: unknown): void => {
		if (!controller.signal.aborted) {
			controller.abort(isAbortError(error) || asErrorDTO(error).kind === "Cancelled" ? undefined : new DeliveryFailed(error))
		}
	}
	const delivery =
		items.length > 1 ? zipDelivery(i18n.t("transfers:transfersZipDownloadDefaultName"), controller.signal, onEnded, downloadBlob) : null

	if (delivery === null) {
		for await (const file of exportFiles(items, target, context, run)) {
			downloadBlob(`${fileStem(file.name)}.${extension}`, file.blob)
		}

		toast.dismiss(run.id)

		const [only] = run.outcomes

		if (!controller.signal.aborted && only !== undefined) {
			if (only.failed !== null) {
				toast.error(messageText(only.failed), { description: only.name })
			}

			for (const warning of only.warnings) {
				toast.warning(messageText(warning), { description: only.name })
			}
		}

		return
	}

	let zip: ZipDelivery

	try {
		zip = await delivery
	} catch (error) {
		if (!isPickerCancelled(error)) {
			log.error("drive", "download as could not start its zip", error)
			toast.error(errorLabel(error))
		}

		return
	}

	const pdfs = exportFiles(items, target, context, run)
	const name = zipEntryNamer(extension)

	try {
		const first = await pdfs.next()

		if (first.done === true) {
			// No PDF came of it: nothing is saved.
			await zip.fail(new Error("nothing to save"))
		} else {
			async function* files(): AsyncGenerator<ZipFile> {
				let next: IteratorResult<{ name: string; blob: Blob }> = first

				while (next.done !== true) {
					yield { name: await name(next.value.name), blob: next.value.blob, modified: new Date() }
					// Nothing is read while the archive's download starts (ZipDelivery.ready).
					await zip.ready()
					next = await pdfs.next()
				}
			}

			// A cancelled run's archive is never finished (its end records never written).
			await writeZipOf(files(), {
				write: chunk => {
					controller.signal.throwIfAborted()

					return zip.sink.write(chunk)
				},
				close: () => {
					controller.signal.throwIfAborted()

					return zip.sink.close()
				}
			})
			await zip.saved()
		}
	} catch (error) {
		await zip.fail(error)

		if (!controller.signal.aborted) {
			controller.abort(new DeliveryFailed(error))
		}
	} finally {
		await pdfs.return(undefined)
	}

	toast.dismiss(run.id)

	const reason: unknown = controller.signal.reason

	if (reason instanceof DeliveryFailed) {
		log.error("drive", "download as zip failed", reason.error)
		toast.error(errorLabel(reason.error))
	} else if (!controller.signal.aborted) {
		reportBulk(run.outcomes)
	}
}

// Why a bulk run ended that was not the user's Cancel: its archive could not be saved.
class DeliveryFailed {
	readonly error: unknown

	constructor(error: unknown) {
		this.error = error
	}
}
