import { describe, it, expect, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { catalogIssues, missingKeys, type Catalog } from "@filen/shared/tooling/i18n"
import { LANGUAGE_LABELS as SHARED_LABELS, SUPPORTED_LANGUAGES as SHARED_LANGUAGES } from "@filen/shared/languages"
import { SUPPORTED_LANGUAGES } from "@/locales/languages"
import { LANGUAGE_LABELS } from "@/lib/language"

// @/lib/language reads its hook from secureStore, which pulls in Expo.
vi.mock("@/lib/secureStore", () => ({ useSecureStore: vi.fn() }))

const LOCALES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../locales")

function readCatalog(name: string): Catalog {
	return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, name), "utf8")) as Catalog
}

const SNAPSHOT = readCatalog(".en-snapshot.json")
const TARGETS = SUPPORTED_LANGUAGES.filter(lang => lang !== "en")

describe("language list", () => {
	it("is the shared list, literally copied for app.config.ts", () => {
		expect([...SUPPORTED_LANGUAGES]).toEqual([...SHARED_LANGUAGES])
	})

	it("labels every language with the shared native names", () => {
		expect(LANGUAGE_LABELS).toBe(SHARED_LABELS)
	})
})

// Against the snapshot (the English the catalogs were last translated from), never the live English, so an English
// edit does not fail CI before its translation run lands.
describe.each(TARGETS)("%s catalog", lang => {
	const catalog = readCatalog(`${lang}.json`)

	it("has every snapshot key", () => {
		expect(missingKeys(SNAPSHOT, catalog)).toEqual([])
	})

	it("keeps English placeholders, markup and the language's plural forms", () => {
		expect(catalogIssues(SNAPSHOT, catalog, lang)).toEqual([])
	})
})
