import { describe, expect, it } from "vitest"
import { createInstance } from "i18next"
import { EN_CATALOGS } from "@/lib/i18n/catalog"
import { singleOrCountKey } from "@/lib/i18n"
import { pageChangeAnnouncement } from "@/features/pdf/pages/organise.logic"
import { extractSuffix } from "@/features/pdf/pages/names"

// Russian puts 21 in the plural `one` category; the English catalog registered as "ru" shows which form is picked.
async function russianRules() {
	const i18n = createInstance()

	await i18n.init({ resources: { ru: EN_CATALOGS }, lng: "ru", defaultNS: "preview", interpolation: { escapeValue: false } })

	return i18n.getFixedT("ru", "preview")
}

describe("singleOrCountKey", () => {
	it("picks the single key for exactly one and the plural key otherwise", () => {
		expect(singleOrCountKey(1, "single", "counted")).toBe("single")
		expect(singleOrCountKey(0, "single", "counted")).toBe("counted")
		expect(singleOrCountKey(21, "single", "counted")).toBe("counted")
	})

	it("counts 21 rotated pages under Russian plural rules, and names the page of a single one", async () => {
		const t = await russianRules()
		const pages = Array.from({ length: 21 }, (_, index) => index)

		expect(pageChangeAnnouncement(t, { kind: "rotated", pages })).toContain("21")
		expect(pageChangeAnnouncement(t, { kind: "rotated", pages: [4] })).toBe("Page 5 rotated")
	})

	it("counts every converted _one under Russian plural rules", async () => {
		const t = await russianRules()

		expect(t(singleOrCountKey(21, "previewSheetHideRowsSingle", "previewSheetHideRows"), { count: 21 })).toBe("Hide 21 row")
		expect(t(singleOrCountKey(21, "previewCalendarEveryDaySingle", "previewCalendarEveryDay"), { count: 21 })).toBe("Every 21 day")
		expect(t(singleOrCountKey(1, "previewCalendarEveryDaySingle", "previewCalendarEveryDay"), { count: 1 })).toBe("Every day")
	})

	it("names 21 extracted pages in the plural under Russian plural rules, and one page in the singular", async () => {
		const t = await russianRules()

		expect(extractSuffix(t, [{ first: 1, last: 21 }])(1)).toBe("pages 1-21")
		expect(extractSuffix(t, [{ first: 3, last: 3 }])(1)).toBe("page 3")
	})
})
