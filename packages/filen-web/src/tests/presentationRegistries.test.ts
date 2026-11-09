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
	type PresentationRibbonContext,
	type PresentationTab
} from "@/features/presentation/components/ribbon/tabs"
import { PRESENTATION_ACTIONS } from "@/features/presentation/lib/keymap"

// The presentation editor's static registries: the ribbon's tabs and their group files, the File menu's entry files
// and the keymap, and what each must keep as slices fill them.

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

	it("gives every tab its group files with unique group ids, and offers no edit groups in a view-only deck", () => {
		const all = context(new Set(["shape", "text", "picture", "table", "chart", "video", "audio", "smartart"]))
		const viewOnly = { ...all, editable: false }

		for (const tab of PRESENTATION_TABS) {
			expect(tab.groups.length, tab.id).toBeGreaterThan(0)
			const ids = presentationTabGroups(tab, all).map(group => group.id)

			expect(new Set(ids).size, tab.id).toBe(ids.length)
		}

		const tab = (id: string): PresentationTab => {
			const found = PRESENTATION_TABS.find(entry => entry.id === id)

			if (found === undefined) throw new Error(`no tab ${id}`)

			return found
		}

		expect(presentationTabGroups(tab("home"), all).map(group => group.id)).toEqual(expect.arrayContaining(["history", "slides"]))
		expect(presentationTabGroups(tab("insert"), all).map(group => group.id)).toContain("slides")
		expect(presentationTabGroups(tab("home"), viewOnly).map(group => group.id)).not.toContain("slides")
		expect(presentationTabGroups(tab("insert"), viewOnly)).toEqual([])
		expect(presentationTabGroups(tab("view"), viewOnly).map(group => group.id)).toEqual(["panes", "zoom"])
	})

	it("lists one File menu entry component per owner, and names its keys uniquely", () => {
		for (const entry of [
			PresentationSaveEntries,
			PresentationExportEntries,
			PresentationDownloadAsEntries,
			PresentationTemplatesEntries
		]) {
			expect(typeof entry).toBe("function")
		}

		expect(new Set(PRESENTATION_ACTIONS.map(action => action.id)).size).toBe(PRESENTATION_ACTIONS.length)

		for (const action of PRESENTATION_ACTIONS) {
			expect(action.id).toMatch(/^presentation\./u)
			expect(action.scope).toBe("editor")
			expect(action.descriptionKey).toMatch(/^preview:previewPptx/u)
		}
	})

	it("reaches the presentation protocol through the office package", () => {
		const methods: readonly PresentationMethod[] = PRESENTATION_METHODS

		expect(methods).toContain("render")
	})
})
