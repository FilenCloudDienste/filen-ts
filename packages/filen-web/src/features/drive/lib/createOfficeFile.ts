import { blankDocx, blankOdp, blankOds, blankOdt, blankPptx, blankXlsx } from "@filen/office/core/templates"
import { extensionOf } from "@/features/drive/lib/preview.logic"

// The blank office files New ▸ Office creates.
export type NewOfficeKind = "docx" | "xlsx" | "pptx" | "odt" | "ods" | "odp"

export const OFFICE_FILE_MIME: Readonly<Record<NewOfficeKind, string>> = {
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	odt: "application/vnd.oasis.opendocument.text",
	ods: "application/vnd.oasis.opendocument.spreadsheet",
	odp: "application/vnd.oasis.opendocument.presentation"
}

// What the kind makes, for the dialog's wording.
export type OfficeFileClass = "document" | "spreadsheet" | "presentation"

export function officeFileClass(kind: NewOfficeKind): OfficeFileClass {
	switch (kind) {
		case "docx":
		case "odt":
			return "document"
		case "xlsx":
		case "ods":
			return "spreadsheet"
		case "pptx":
		case "odp":
			return "presentation"
	}
}

// The kind's extension added unless the name already ends with it: a blank .docx named "notes.txt" would open as text.
export function normalizeOfficeFileName(name: string, kind: NewOfficeKind): string {
	return extensionOf(name) === kind ? name : `${name}.${kind}`
}

// "base.ext", or "base (2).ext", "(3)"… past the names in `taken` (lowercased: names are unique per directory
// case-insensitively).
export function freeOfficeFileName(base: string, kind: NewOfficeKind, taken: ReadonlySet<string>): string {
	for (let attempt = 1; ; attempt++) {
		const candidate = attempt === 1 ? `${base}.${kind}` : `${base} (${String(attempt)}).${kind}`

		if (!taken.has(candidate.toLowerCase())) {
			return candidate
		}
	}
}

export interface OfficeTemplateLocale {
	// BCP 47: the paper (Letter in the US, Canada, Mexico and the Philippines, else A4) and a document's language.
	locale: string
	// A workbook's first sheet, in the user's language.
	sheetName: string
}

export function officeFileBytes(kind: NewOfficeKind, { locale, sheetName }: OfficeTemplateLocale): Promise<Uint8Array> {
	switch (kind) {
		case "docx":
			return blankDocx({ locale })
		case "xlsx":
			return blankXlsx({ locale, sheetName })
		case "odt":
			return blankOdt({ locale })
		case "ods":
			return blankOds({ locale, sheetName })
		case "pptx":
			return blankPptx({ locale })
		case "odp":
			return blankOdp({ locale })
	}
}
