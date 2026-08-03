import { describe, expect, it } from "vitest"
import { EN_CATALOGS, EN_NAMESPACES } from "@/lib/i18n/catalog"
import { SHORTCUT_NAMESPACES } from "@/lib/keymap/shortcutsCatalog"

// The catalog module is the single namespace list the app, the i18next type augmentation and the
// translation pipeline all read. A namespace that falls out of it stops being translated, so the
// invariants below are what stop that from happening silently.
describe("EN_NAMESPACES / EN_CATALOGS", () => {
	it("lists every namespace exactly once", () => {
		expect(new Set(EN_NAMESPACES).size).toBe(EN_NAMESPACES.length)
	})

	it("has exactly one catalog per namespace", () => {
		expect(new Set(Object.keys(EN_CATALOGS))).toEqual(new Set(EN_NAMESPACES))
	})

	it("ships a non-empty flat string record for every namespace", () => {
		for (const namespace of EN_NAMESPACES) {
			const catalog: Record<string, unknown> = EN_CATALOGS[namespace]
			const entries = Object.entries(catalog)

			expect(entries.length).toBeGreaterThan(0)

			for (const [key, value] of entries) {
				expect(typeof value, `${namespace}:${key} must be a string`).toBe("string")
			}
		}
	})

	it("uses no key containing i18next's key or namespace separator", () => {
		// The app runs i18next's default keySeparator ('.') and nsSeparator (':'), so a key holding
		// either character is unaddressable through t().
		for (const namespace of EN_NAMESPACES) {
			const catalog: Record<string, unknown> = EN_CATALOGS[namespace]

			for (const key of Object.keys(catalog)) {
				expect(key.includes("."), `${namespace}:${key}`).toBe(false)
				expect(key.includes(":"), `${namespace}:${key}`).toBe(false)
			}
		}
	})

	it("covers every namespace the shortcuts UI loads", () => {
		for (const namespace of SHORTCUT_NAMESPACES) {
			expect(EN_NAMESPACES).toContain(namespace)
		}
	})
})
