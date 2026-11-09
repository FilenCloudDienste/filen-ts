import { describe, expect, it } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { catalogIssues, missingKeys, type Catalog } from "@filen/shared/tooling/i18n"
import { DESKTOP_SHELL_STRINGS } from "@filen/shared/desktopShellStrings"
import { SUPPORTED_LANGUAGES } from "@filen/shared/languages"
import { EN_CATALOGS, EN_NAMESPACES } from "@/lib/i18n/catalog"
import { offeredLanguages } from "@/lib/i18n/language"
import manifest from "@/locales/.catalogs.json"

const LOCALES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "locales")
const EN_DIR = join(LOCALES_DIR, "en")

const IMPORT_PATTERN = /^import\s+\{([^}]*)\}\s+from\s+"@\/locales\/en\/([^"]+)"/gm
// A key of the namespace's own object literal: one tab deep, bare or quoted.
const OWN_KEY_PATTERN = /^\t(?:"([^"]+)"|([A-Za-z_$][\w$]*))\s*:/gm

// The spread sub-catalogs of a namespace file: export name and module path.
function spreadImports(source: string): { names: string[]; path: string }[] {
	return Array.from(source.matchAll(IMPORT_PATTERN), match => ({
		names: (match[1] ?? "")
			.split(",")
			.map(name => name.trim())
			.filter(name => name.length > 0),
		path: match[2] ?? ""
	}))
}

function readNested(file: string): Record<string, Catalog> {
	return JSON.parse(readFileSync(join(LOCALES_DIR, file), "utf8")) as Record<string, Catalog>
}

describe("English catalog files", () => {
	// A spread silently lets a later file's key overwrite an earlier one with the same name.
	it.each(EN_NAMESPACES)("%s has no key in two of its files", async ns => {
		const source = readFileSync(join(EN_DIR, `${ns}.ts`), "utf8")
		const owners = new Map<string, string>()
		const duplicates: string[] = []
		const own = source.replace(/^import[^\n]*\n/gm, "")
		let counted = 0

		const claim = (key: string, owner: string) => {
			const previous = owners.get(key)

			counted++

			if (previous !== undefined) {
				duplicates.push(`${key} (${previous}, ${owner})`)
			}

			owners.set(key, owner)
		}

		for (const match of own.matchAll(OWN_KEY_PATTERN)) {
			claim(match[1] ?? match[2] ?? "", `${ns}.ts`)
		}

		for (const { names, path } of spreadImports(source)) {
			const module = (await import(/* @vite-ignore */ join(EN_DIR, `${path}.ts`))) as Record<
				string,
				Record<string, string> | undefined
			>

			for (const name of names) {
				for (const key of Object.keys(module[name] ?? {})) {
					claim(key, path)
				}
			}
		}

		expect(duplicates).toEqual([])
		// Every key the namespace ships was seen above, so a key the scan missed cannot hide a duplicate.
		expect(owners.size).toBe(Object.keys(EN_CATALOGS[ns]).length)
		expect(counted).toBeGreaterThan(0)
	})

	it.each(EN_NAMESPACES)("%s pairs every English plural form and uses only English categories", ns => {
		const keys = new Set(Object.keys(EN_CATALOGS[ns]))
		const problems: string[] = []

		for (const key of keys) {
			const match = /^(.+)_(one|other|zero|two|few|many)$/.exec(key)

			if (match === null) {
				continue
			}

			const [, base, category] = match

			if (category === "one" && !keys.has(`${base ?? ""}_other`)) {
				problems.push(`${key} has no _other`)
			}

			// _zero is i18next's own count-0 form; the other CLDR categories come from translation.
			if (category === "two" || category === "few" || category === "many") {
				problems.push(`${key}: English has only _zero / _one / _other`)
			}
		}

		expect(problems).toEqual([])
	})

	it("ships the desktop shell's strings in the settings namespace", () => {
		expect(EN_CATALOGS.settings).toMatchObject(DESKTOP_SHELL_STRINGS)
	})
})

const TARGET_FILES = readdirSync(LOCALES_DIR).filter(name => /^[a-zA-Z-]+\.json$/.test(name))

describe("translated catalogs", () => {
	it("are named after supported languages", () => {
		for (const file of TARGET_FILES) {
			expect(SUPPORTED_LANGUAGES).toContain(file.slice(0, -".json".length))
		}
	})

	// Against the snapshot (the English the catalogs were last translated from), never the live English, so an
	// English edit does not fail CI before its translation run lands; a language below the offer threshold is not
	// held to completeness.
	it.runIf(TARGET_FILES.length > 0).each(TARGET_FILES)("%s matches the snapshot", file => {
		const lang = file.slice(0, -".json".length)
		const catalog = readNested(file)
		const snapshot = readNested(".en-snapshot.json")
		const total = Object.values(snapshot).reduce((sum, ns) => sum + Object.keys(ns).length, 0)
		const offered = offeredLanguages(manifest.languages, total).some(code => code === lang)
		const problems: string[] = []

		for (const [ns, english] of Object.entries(snapshot)) {
			const target = catalog[ns] ?? {}

			problems.push(...catalogIssues(english, target, lang).map(issue => `${ns}:${issue}`))

			if (offered) {
				problems.push(...missingKeys(english, target).map(key => `${ns}:${key} missing`))
			}
		}

		expect(problems).toEqual([])
	})
})
