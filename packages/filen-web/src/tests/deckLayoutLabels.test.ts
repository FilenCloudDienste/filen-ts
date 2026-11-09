import { describe, expect, it } from "vitest"
import type { TFunction } from "i18next"
import type { SlideRef } from "@filen/office/core/presentation"
import { layoutLabel, layoutsByMaster } from "@/features/presentation/components/deckChrome.logic"
import { previewPptxRibbon } from "@/locales/en/previewPptx/ribbon"

// The Layout menus name a layout by the file's name, else by its ST_SlideLayoutType as PowerPoint names its default
// layouts (an ODP layout on a LibreOffice "AL<n>T<k>" page layout has no name), else "Layout N".

const t = ((key: string, options?: { number?: number }) =>
	(previewPptxRibbon as Record<string, string>)[key]?.replace(
		"{{number}}",
		String(options?.number ?? "")
	)) as unknown as TFunction<"preview">

describe("layout menu labels", () => {
	it("names a layout by the file's name, else its type, else its number within its master", () => {
		const [group] = layoutsByMaster([
			{ ref: 1 as SlideRef, master: 9 as SlideRef, type: "title", name: "Opening" },
			{ ref: 2 as SlideRef, master: 9 as SlideRef, type: "obj" },
			{ ref: 3 as SlideRef, master: 9 as SlideRef, type: "fourObj" },
			{ ref: 4 as SlideRef, master: 9 as SlideRef }
		])

		expect(group?.layouts.map(layout => layoutLabel(t, layout))).toEqual(["Opening", "Title and Content", "Layout 3", "Layout 4"])
	})
})
