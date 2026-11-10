import * as Comlink from "comlink"
import { extensionOf } from "@/features/drive/lib/preview.logic"
import type { TemplatePaper } from "@filen/office/core/templates"
import type { OfficeTemplateApi } from "@/features/drive/lib/officeTemplates"
import OfficeTemplateWorker from "@/features/drive/workers/officeTemplate.worker.ts?worker"
import { recoverIfNewerBuild } from "@/lib/appUpdate"

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
	// The user's paper (Settings, Office) in place of the locale's; a presentation has none.
	paper?: TemplatePaper | undefined
	// A workbook's first sheet, in the user's language.
	sheetName: string
}

// The blank file, built in a worker spawned for it and ended after (officeTemplates.ts): New ▸ Office is rare, and
// the templates would otherwise be parsed with the main bundle on every load.
export async function officeFileBytes(kind: NewOfficeKind, locale: OfficeTemplateLocale): Promise<Uint8Array> {
	const worker = new OfficeTemplateWorker()
	const remote = Comlink.wrap<OfficeTemplateApi>(worker)
	const failed = new Promise<never>((_, reject) => {
		worker.addEventListener("error", event => {
			// A deploy that changed this worker removes its old file (appUpdate.ts).
			recoverIfNewerBuild()
			reject(new Error(`office template worker failed: ${event.message}`))
		})
	})

	try {
		return await Promise.race([remote.bytes(kind, locale), failed])
	} finally {
		remote[Comlink.releaseProxy]()
		worker.terminate()
	}
}
