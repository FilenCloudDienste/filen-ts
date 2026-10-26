import type { TFunction } from "i18next"
import { PRESENTATION_METHODS, type PresentationMethod } from "@filen/office/dom/presentation"
import { describe, expect, it } from "vitest"
import { PresentationDownloadAsEntries } from "@/features/presentation/components/fileMenu/downloadAs"
import { PresentationExportEntries } from "@/features/presentation/components/fileMenu/export"
import { PresentationSaveEntries } from "@/features/presentation/components/fileMenu/save"
import { PresentationTemplatesEntries } from "@/features/presentation/components/fileMenu/templates"
import {
	PRESENTATION_TABS,
	presentationTabGroups,
	presentationTabs,
	type PresentationRibbonContext
} from "@/features/presentation/components/ribbon/tabs"
import { PRESENTATION_ACTIONS } from "@/features/presentation/lib/keymap"

// The presentation editor's static registries: the ribbon's tabs and their group files, the File menu's entry files
// and the keymap, before any slice fills them.

function context(selection: PresentationRibbonContext["selection"]): PresentationRibbonContext {
	return { editable: true, phone: false, selection, t: ((key: string) => key) as unknown as TFunction }
}

describe("presentation registries", () => {
	it("lists the nine tabs in order, then the contextual ones", () => {
		expect(PRESENTATION_TABS.map(tab => tab.id)).toEqual([
			"home",
			"insert",
			"design",
			"transitions",
			"animations",
			"slideShow",
			"review",
			"view",
			"arrange",
			"shapeFormat",
			"picture",
			"table",
			"chart",
			"video",
			"audio",
			"smartartDesign",
			"smartartFormat"
		])
	})

	it("shows a contextual tab only while its object is selected", () => {
		expect(presentationTabs(context(new Set())).map(tab => tab.id)).toHaveLength(9)
		expect(
			presentationTabs(context(new Set(["smartart"])))
				.map(tab => tab.id)
				.slice(9)
		).toEqual(["smartartDesign", "smartartFormat"])
		expect(
			presentationTabs(context(new Set(["text"])))
				.map(tab => tab.id)
				.slice(9)
		).toEqual(["shapeFormat"])
	})

	it("gives every tab its group files, none with groups yet", () => {
		const all = context(new Set(["shape", "text", "picture", "table", "chart", "video", "audio", "smartart"]))

		for (const tab of PRESENTATION_TABS) {
			expect(tab.groups.length, tab.id).toBeGreaterThan(0)
			expect(presentationTabGroups(tab, all), tab.id).toEqual([])
		}
	})

	it("renders no File menu entries and registers no keys yet", () => {
		const props = { context: { editable: true, downloads: true, close: () => undefined } }

		expect([
			PresentationSaveEntries(props),
			PresentationExportEntries(props),
			PresentationDownloadAsEntries(props),
			PresentationTemplatesEntries(props)
		]).toEqual([null, null, null, null])
		expect(PRESENTATION_ACTIONS).toEqual([])
	})

	it("reaches the presentation protocol through the office package", () => {
		const methods: readonly PresentationMethod[] = PRESENTATION_METHODS

		expect(methods).toContain("render")
	})
})
