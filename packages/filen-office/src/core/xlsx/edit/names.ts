import type { SheetId } from "../../sheet/protocol"
import { defineSheetFeature } from "../../sheet/registry"
import type { XlsxDocument } from "./document"

// The workbook's defined names as the app's name box lists and follows them (ECMA-376 Part 1 §18.2.6 definedName):
// hidden ones are left out, as Excel's Name Box leaves them out.

declare module "../../sheet/protocol" {
	interface SheetQueryMap {
		"names.list": { request: Record<string, never>; result: readonly SheetDefinedName[] }
	}
}

export interface SheetDefinedName {
	readonly name: string
	// The sheet a local name belongs to, null for a workbook-wide one.
	readonly sheet: SheetId | null
	// What it refers to, as written (no leading "=").
	readonly formula: string
}

export const namesFeature = defineSheetFeature<XlsxDocument>({
	id: "names",
	queries: {
		"names.list": {
			run: context => {
				const names: SheetDefinedName[] = []

				for (const entry of context.doc.workbook.definedNames) {
					if (!entry.hidden) names.push({ name: entry.name, sheet: entry.sheet, formula: entry.formula })
				}

				return names
			}
		}
	}
})
