import { describe, expect, it } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { settings } from "@/locales/en/settings"

// The typed-confirm gate is an exact match against the translated phrase the dialog shows, so in every language the
// two bulk-delete phrases must be typeable (non-empty) and distinct, or typing one row's phrase would arm the other's.

const LOCALES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "locales")
const VERSIONS = "settingsDeleteAllVersionsTypedConfirmPhrase"
const ITEMS = "settingsDeleteAllItemsTypedConfirmPhrase"

function expectDistinct(versions: string, items: string): void {
	expect(versions.trim().length).toBeGreaterThan(0)
	expect(items.trim().length).toBeGreaterThan(0)
	expect(versions).not.toBe(items)
}

describe("bulk-delete typed-confirm phrases", () => {
	it("are non-empty and distinct in English", () => {
		expectDistinct(settings[VERSIONS], settings[ITEMS])
	})

	const translated = readdirSync(LOCALES_DIR).filter(file => file.endsWith(".json") && !file.startsWith("."))

	it.each(translated)("are non-empty and distinct in %s where translated", file => {
		const catalog = (JSON.parse(readFileSync(join(LOCALES_DIR, file), "utf8")) as { settings?: Record<string, unknown> }).settings ?? {}
		const versions = catalog[VERSIONS]
		const items = catalog[ITEMS]

		if (typeof versions === "string" && typeof items === "string") {
			expectDistinct(versions, items)
		} else {
			// Not translated yet: the English pair stands in for both.
			expect(versions === undefined || typeof versions === "string").toBe(true)
			expect(items === undefined || typeof items === "string").toBe(true)
		}
	})
})
