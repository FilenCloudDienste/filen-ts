import { driveItemName } from "@filen/shared"
import { FileSpreadsheetIcon, FileTextIcon, PresentationIcon, type LucideIcon } from "lucide-react"
import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import { canPreview, extensionOf, previewType } from "@/features/drive/lib/preview.logic"
import { type DriveKey } from "@/lib/i18n"

// Download as in the item menus, the parts without a DOM: which files can be exported and to what. A file is
// exported from the saved file, laid out headless as its viewer lays it out, and downloaded; the drive is unchanged.

// The engine a file is exported from: the document viewer's (Word, Word 97–2003, OpenDocument text, RTF), the
// spreadsheet viewer's (Excel, Excel 97–2003, OpenDocument spreadsheet, CSV and TSV) or the presentation viewer's
// (PowerPoint, PowerPoint 97–2003, OpenDocument presentation).
export type DownloadAsSource = "document" | "spreadsheet" | "presentation"

export type DownloadAsTarget = "pdf" | "docx" | "odt" | "xlsx" | "ods" | "pptx" | "odp"

// The format a file is in, by its extension, as far as a conversion cares: the Word family, OpenDocument text, RTF,
// Word 97–2003; the Excel family, OpenDocument spreadsheet, Excel 97–2003, delimited text; the PowerPoint family,
// OpenDocument presentation, PowerPoint 97–2003.
export type DownloadAsFormat = "docx" | "odt" | "rtf" | "doc" | "xlsx" | "ods" | "xls" | "text" | "pptx" | "odp" | "ppt"

const FORMATS: Readonly<Record<string, DownloadAsFormat>> = {
	docx: "docx",
	docm: "docx",
	dotx: "docx",
	dotm: "docx",
	odt: "odt",
	ott: "odt",
	rtf: "rtf",
	doc: "doc",
	dot: "doc",
	xlsx: "xlsx",
	xlsm: "xlsx",
	xltx: "xlsx",
	xltm: "xlsx",
	ods: "ods",
	ots: "ods",
	xls: "xls",
	xlt: "xls",
	csv: "text",
	tsv: "text",
	tab: "text",
	pptx: "pptx",
	pptm: "pptx",
	potx: "pptx",
	potm: "pptx",
	ppsx: "pptx",
	ppsm: "pptx",
	odp: "odp",
	otp: "odp",
	ppt: "ppt",
	pps: "ppt",
	pot: "ppt"
}

export interface DownloadAsTargetDef {
	readonly labelKey: DriveKey
	readonly icon: LucideIcon
	// The extension the download is named with.
	readonly extension: string
	// The formats exported to it (never the target's own: a file is not offered its own format).
	readonly from: ReadonlySet<DownloadAsFormat>
}

const DOCUMENTS = ["docx", "odt", "rtf", "doc"] as const
const SPREADSHEETS = ["xlsx", "ods", "xls", "text"] as const
const PRESENTATIONS = ["pptx", "odp", "ppt"] as const

export const DOWNLOAD_AS_TARGETS: Readonly<Record<DownloadAsTarget, DownloadAsTargetDef>> = {
	// Every document, spreadsheet and presentation the viewers open, by name or by content.
	pdf: {
		labelKey: "driveDownloadAsPdf",
		icon: FileTextIcon,
		extension: "pdf",
		from: new Set([...DOCUMENTS, ...SPREADSHEETS, ...PRESENTATIONS])
	},
	docx: { labelKey: "driveDownloadAsDocx", icon: FileTextIcon, extension: "docx", from: new Set(["odt", "rtf", "doc"]) },
	odt: { labelKey: "driveDownloadAsOdt", icon: FileTextIcon, extension: "odt", from: new Set(["docx", "rtf", "doc"]) },
	xlsx: { labelKey: "driveDownloadAsXlsx", icon: FileSpreadsheetIcon, extension: "xlsx", from: new Set(["ods", "xls", "text"]) },
	ods: { labelKey: "driveDownloadAsOds", icon: FileSpreadsheetIcon, extension: "ods", from: new Set(["xlsx", "xls", "text"]) },
	pptx: { labelKey: "driveDownloadAsPptx", icon: PresentationIcon, extension: "pptx", from: new Set(["odp", "ppt"]) },
	odp: { labelKey: "driveDownloadAsOdp", icon: PresentationIcon, extension: "odp", from: new Set(["pptx", "ppt"]) }
}

// The submenu's entries in groups, a rule between groups (the PDF, then the editable formats a file converts to).
const DOWNLOAD_AS_GROUPS: readonly (readonly DownloadAsTarget[])[] = [["pdf"], ["docx", "odt", "xlsx", "ods", "pptx", "odp"]]

// What format an exportable file is in, by its extension; null for one named otherwise (opened by its content), which
// is offered the PDF only: what it converts to is not known before it is read. A presentation is always named as one.
export function downloadAsFormat(item: DriveItem): DownloadAsFormat | null {
	return FORMATS[extensionOf(driveItemName(item))] ?? null
}

// What a file is exported from; null for anything the viewers do not open: a directory, an undecryptable file, a
// file of another kind, or one past its viewer's size cap (bufferedSizeCap: the export holds the same whole buffer
// and lays it out as the viewer would, so a file the viewer refuses to load is never loaded for an export either).
export function downloadAsSource(item: DriveItem): DownloadAsSource | null {
	const base = asDirectoryOrFile(item)

	if (base.type !== "file" || base.data.undecryptable || !canPreview(item)) {
		return null
	}

	switch (previewType(item)) {
		case "docx":
			return "document"
		case "spreadsheet":
			return "spreadsheet"
		// Read in ranges by its worker, as the viewer reads it: any size opens (canPreview).
		case "presentation":
			return "presentation"
		default:
			return null
	}
}

// The targets every one of `items` exports to, grouped; empty when any item exports to none (the bulk menus offer
// Download as only when every selected item can be exported, as Extract only when every one is an archive).
export function downloadAsTargets(items: readonly DriveItem[]): DownloadAsTarget[][] {
	const formats: (DownloadAsFormat | null)[] = []

	for (const item of items) {
		if (downloadAsSource(item) === null) {
			return []
		}

		formats.push(downloadAsFormat(item))
	}

	if (formats.length === 0) {
		return []
	}

	// A file named otherwise converts to the PDF alone (no presentation is: a deck is always named as one).
	return DOWNLOAD_AS_GROUPS.map(group =>
		group.filter(target => formats.every(format => (format === null ? target === "pdf" : DOWNLOAD_AS_TARGETS[target].from.has(format))))
	).filter(group => group.length > 0)
}

export function canDownloadAs(items: readonly DriveItem[]): boolean {
	return downloadAsTargets(items).length > 0
}
