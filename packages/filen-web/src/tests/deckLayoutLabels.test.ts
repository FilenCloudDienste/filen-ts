import { describe, expect, it } from "vitest"
import type { TFunction } from "i18next"
import { bytesSource } from "@filen/office/core/opc"
import { openPptx } from "@filen/office/core/pptx"
import type { SlideRef } from "@filen/office/core/presentation"
import { layoutLabel, layoutNames, layoutsByMaster } from "@/features/presentation/components/deckChrome.logic"
import { officeTemplateBytes } from "@/features/drive/lib/officeTemplates"
import { previewPptxRibbon } from "@/locales/en/previewPptx/ribbon"

// The Layout menus name a layout by the file's name, else by its ST_SlideLayoutType as PowerPoint names its default
// layouts (an ODP layout on a LibreOffice "AL<n>T<k>" page layout has no name), else "Layout N".

const english = (key: string, options?: { number?: number }): string =>
	(previewPptxRibbon as Record<string, string>)[key]?.replace("{{number}}", String(options?.number ?? "")) ?? key
const t = english as unknown as TFunction<"preview">
// Another language: every string marked.
const german = ((key: string, options?: { number?: number }) => `DE ${english(key, options)}`) as unknown as TFunction<"preview">

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

	it("shows a new presentation's layouts in the user's language, and a renamed layout by its own name", async () => {
		const bytes = await officeTemplateBytes("pptx", { locale: "de-DE", sheetName: "", layoutNames: layoutNames(german) })
		const opened = await openPptx(bytesSource(bytes))

		if (opened.kind !== "opened") throw new Error("not opened")

		const deck = opened.deck
		const layouts = deck.layouts.flatMap(ref => {
			const node = deck.nodes.get(ref)

			return node?.parent === undefined
				? []
				: [
						{
							ref,
							master: node.parent,
							...(node.layoutType === undefined ? {} : { type: node.layoutType }),
							...(node.name === undefined ? {} : { name: node.name })
						}
					]
		})
		const [group] = layoutsByMaster(layouts)
		const labels = group?.layouts.map(layout => layoutLabel(german, layout))

		expect(labels).toHaveLength(11)
		expect(labels?.slice(0, 3)).toEqual(["DE Title Slide", "DE Title and Content", "DE Section Header"])
		expect(labels?.every(label => label.startsWith("DE "))).toBe(true)

		const renamed = layoutsByMaster([{ ...(layouts[0] ?? { ref: 1 as SlideRef, master: 9 as SlideRef }), name: "Opening" }])

		expect(renamed[0]?.layouts.map(layout => layoutLabel(german, layout))).toEqual(["Opening"])
	})
})
