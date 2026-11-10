import * as Comlink from "comlink"
import { blankDocx, blankOdp, blankOds, blankOdt, blankPptx, blankXlsx } from "@filen/office/core/templates"
import type { NewOfficeKind, OfficeTemplateLocale } from "@/features/drive/lib/createOfficeFile"

// The blank files New ▸ Office makes, built in officeTemplate.worker.ts: the templates (a presentation's theme,
// master and layouts among them) stay out of the main bundle. Imported by that worker only.

export function officeTemplateBytes(kind: NewOfficeKind, { locale, sheetName, paper }: OfficeTemplateLocale): Promise<Uint8Array> {
	switch (kind) {
		case "docx":
			return blankDocx({ locale, paper })
		case "xlsx":
			return blankXlsx({ locale, sheetName, paper })
		case "odt":
			return blankOdt({ locale, paper })
		case "ods":
			return blankOds({ locale, sheetName, paper })
		case "pptx":
			return blankPptx({ locale })
		case "odp":
			return blankOdp({ locale })
	}
}

export const officeTemplateApi = {
	bytes: async (kind: NewOfficeKind, locale: OfficeTemplateLocale): Promise<Uint8Array> => {
		const bytes = await officeTemplateBytes(kind, locale)

		return Comlink.transfer(bytes, [bytes.buffer])
	}
}

export type OfficeTemplateApi = typeof officeTemplateApi
