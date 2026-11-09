import type { SheetDocumentProperties, SheetFileKind, SheetRange, SheetSummary } from "@filen/office/core/sheet"
import { COMMON_PAPER_SIZES, paperPoints, type SheetPageSetup, type SheetPrintPatch } from "@filen/office/core/sheet/print"
import type { PrintChart, PrintSheetRequest, SheetPdfRequest } from "@filen/office/react/sheet/print"
import type { PreviewKey } from "@/lib/i18n"
import { fileStem } from "@/features/spreadsheet/save/sheetSave.logic"

// The print dialog's choices and what they print: the sheets and ranges, each sheet's setup with the dialog's choices
// over the active sheet's, and the patch that writes them into the file.

export type PrintScope = "sheet" | "workbook" | "selection"

export type PrintScaling = "none" | "fitSheet" | "fitColumns" | "fitRows" | "fitPages" | "custom"

export interface PrintForm {
	readonly scope: PrintScope
	readonly ignorePrintArea: boolean
	readonly paperSize: number
	readonly orientation: "portrait" | "landscape"
	readonly scaling: PrintScaling
	// The custom percent as typed.
	readonly percent: string
	readonly gridLines: boolean
	readonly headings: boolean
}

// What the browser lays out for one print at most (each page an SVG in the document).
export const MAX_BROWSER_PAGES = 500

export const PAPER_KEYS: ReadonlyMap<number, PreviewKey> = new Map<number, PreviewKey>([
	[1, "previewSheetPrintPaperLetter"],
	[5, "previewSheetPrintPaperLegal"],
	[3, "previewSheetPrintPaperTabloid"],
	[7, "previewSheetPrintPaperExecutive"],
	[9, "previewSheetPrintPaperA4"],
	[8, "previewSheetPrintPaperA3"],
	[11, "previewSheetPrintPaperA5"],
	[13, "previewSheetPrintPaperB5"]
])

export const COMMON_PAPERS: readonly number[] = COMMON_PAPER_SIZES

export function scalingOf(setup: SheetPageSetup): PrintScaling {
	if (!setup.fitToPage) return setup.scale === 100 ? "none" : "custom"
	if (setup.fitToWidth === 1 && setup.fitToHeight === 1) return "fitSheet"
	if (setup.fitToWidth === 1 && setup.fitToHeight === 0) return "fitColumns"
	if (setup.fitToWidth === 0 && setup.fitToHeight === 1) return "fitRows"

	return "fitPages"
}

export function formOf(setup: SheetPageSetup, scope: PrintScope = "sheet"): PrintForm {
	return {
		scope,
		ignorePrintArea: false,
		paperSize: setup.customPaper ? 0 : setup.paperSize,
		orientation: setup.orientation,
		scaling: scalingOf(setup),
		percent: String(setup.scale),
		gridLines: setup.gridLines,
		headings: setup.headings
	}
}

// A whole number from 10 to 400, or null.
export function percentOf(text: string): number | null {
	const trimmed = text.trim()

	if (!/^[0-9]{1,3}$/.test(trimmed)) return null

	const value = Number(trimmed)

	return value >= 10 && value <= 400 ? value : null
}

// The dialog's choices over a sheet's setup (the paper of a sheet with custom paper stays its own unless one was
// chosen; "fitPages" keeps the file's page counts).
export function applyForm(setup: SheetPageSetup, form: PrintForm): SheetPageSetup | null {
	const percent = form.scaling === "custom" ? percentOf(form.percent) : 100

	if (percent === null) return null

	const fit =
		form.scaling === "fitSheet"
			? { width: 1, height: 1 }
			: form.scaling === "fitColumns"
				? { width: 1, height: 0 }
				: form.scaling === "fitRows"
					? { width: 0, height: 1 }
					: form.scaling === "fitPages"
						? { width: setup.fitToWidth, height: setup.fitToHeight }
						: null

	return {
		...setup,
		...(form.paperSize !== 0 &&
			(form.paperSize !== setup.paperSize || setup.customPaper) && {
				paperSize: form.paperSize,
				paper: paperPoints(form.paperSize),
				customPaper: false
			}),
		orientation: form.orientation,
		fitToPage: fit !== null,
		fitToWidth: fit?.width ?? setup.fitToWidth,
		fitToHeight: fit?.height ?? setup.fitToHeight,
		scale: fit === null ? percent : setup.scale,
		gridLines: form.gridLines,
		headings: form.headings
	}
}

// What writes the choices into the file: only what differs from the sheet's setup (null: nothing).
export function patchOf(setup: SheetPageSetup, form: PrintForm): SheetPrintPatch | null {
	const next = applyForm(setup, form)

	if (next === null) return null

	const patch: {
		-readonly [K in keyof SheetPrintPatch]: SheetPrintPatch[K]
	} = {}

	if (next.orientation !== setup.orientation) patch.orientation = next.orientation
	if (form.paperSize !== 0 && (setup.customPaper || form.paperSize !== setup.paperSize)) patch.paperSize = form.paperSize
	if (next.fitToPage && (!setup.fitToPage || next.fitToWidth !== setup.fitToWidth || next.fitToHeight !== setup.fitToHeight))
		patch.fit = { width: next.fitToWidth, height: next.fitToHeight }
	if (!next.fitToPage && (setup.fitToPage || next.scale !== setup.scale)) patch.scale = next.scale
	if (next.gridLines !== setup.gridLines) patch.gridLines = next.gridLines
	if (next.headings !== setup.headings) patch.headings = next.headings

	return Object.keys(patch).length === 0 ? null : patch
}

export interface PrintSheetSettings {
	readonly sheet: SheetSummary
	readonly setup: SheetPageSetup
	readonly used: SheetRange | null
	// A chartsheet's chart: it prints on a page of its own.
	readonly chart?: PrintChart
}

// The sheets and ranges a print takes: the active sheet (its print area unless ignored, else its used range), every
// visible worksheet, or the selection's ranges. The dialog's choices apply to the active sheet; the other sheets of a
// workbook print with their own settings, as in Excel.
export function printRequests(
	form: PrintForm,
	active: PrintSheetSettings,
	// Every worksheet, in the workbook's order (the active one included).
	sheets: readonly PrintSheetSettings[],
	selection: readonly SheetRange[]
): PrintSheetRequest[] | null {
	const own = applyForm(active.setup, form)

	if (own === null) return null

	const request = (settings: PrintSheetSettings, setup: SheetPageSetup): PrintSheetRequest => ({
		sheet: settings.sheet.id,
		name: settings.sheet.name,
		setup,
		used: settings.used,
		ranges: setup.printArea !== null && !form.ignorePrintArea ? setup.printArea : settings.used === null ? [] : [settings.used],
		...(settings.chart !== undefined && { chart: settings.chart })
	})

	if (form.scope === "selection") {
		return [
			{
				sheet: active.sheet.id,
				name: active.sheet.name,
				setup: { ...own, printArea: null },
				used: active.used,
				ranges: selection,
				...(active.chart !== undefined && { chart: active.chart })
			}
		]
	}

	if (form.scope === "sheet") return [request(active, own)]

	return sheets
		.filter(settings => settings.sheet.state === "visible")
		.map(settings => (settings.sheet.id === active.sheet.id ? request(settings, own) : request(settings, settings.setup)))
}

// What &D, &T, &F and &Z print: today's date and time as the app formats them, the file's name (no path here).
export function headerValues(name: string, now: Date = new Date()): { date: string; time: string; file: string; path: string } {
	return {
		date: new Intl.DateTimeFormat(undefined, { dateStyle: "short" }).format(now),
		time: new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(now),
		file: name,
		path: ""
	}
}

// The file a sheet's PDF is made of: its name (for headers and footers), its title (the workbook's own, else the
// file's name without its extension, as a document's PDF is titled), its author, subject and keywords when it names
// any, and the language.
export interface SheetPdfFile {
	readonly name: string
	readonly title: string
	readonly properties?: SheetDocumentProperties
	readonly lang: string
}

export function pdfFile(
	name: string,
	workbook: { readonly title?: string; readonly properties?: SheetDocumentProperties },
	lang: string
): SheetPdfFile {
	return {
		name,
		title: workbook.title ?? fileStem(name),
		...(workbook.properties === undefined ? {} : { properties: workbook.properties }),
		lang
	}
}

// A print as the PDF export takes it: the print's sheets and ranges, the header and footer values, the document's
// title (pdfFile) and language, and what the grid shows of the workbook.
export function pdfRequest(
	sheets: readonly PrintSheetRequest[],
	file: SheetPdfFile,
	workbook: {
		readonly kind: SheetFileKind
		readonly sheets: readonly SheetSummary[]
		readonly date1904: boolean
		readonly showFormulas: boolean
	},
	now?: Date
): SheetPdfRequest {
	return {
		sheets,
		values: headerValues(file.name, now),
		title: file.title,
		...(file.properties === undefined ? {} : { properties: file.properties }),
		lang: file.lang,
		kind: workbook.kind,
		summaries: workbook.sheets,
		date1904: workbook.date1904,
		showFormulas: workbook.showFormulas
	}
}
