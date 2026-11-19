import { describe, expect, it } from "vitest"
import { SMARTART_COLORS, SMARTART_LAYOUTS, SMARTART_STYLES } from "@filen/office/core/smartart"
import { EN_CATALOGS } from "@/lib/i18n/catalog"

// The real gallery registry (no mock): every name it shows must be in the English catalog, or the gallery lists the
// raw key as the layout's name and accessible label in every locale.
describe("SmartArt gallery names", () => {
	const preview: Record<string, string> = EN_CATALOGS.preview
	const entries = [...SMARTART_LAYOUTS, ...SMARTART_STYLES, ...SMARTART_COLORS]

	it("registers layouts, styles and colours", () => {
		expect(SMARTART_LAYOUTS.length).toBeGreaterThan(0)
		expect(SMARTART_STYLES.length).toBeGreaterThan(0)
		expect(SMARTART_COLORS.length).toBeGreaterThan(0)
	})

	it("names every entry with a key of the English preview catalog", () => {
		expect(entries.map(entry => entry.nameKey).filter(key => !Object.hasOwn(preview, key))).toEqual([])
	})

	it("gives every entry its own name", () => {
		expect(new Set(entries.map(entry => entry.nameKey)).size).toBe(entries.length)
	})
})
