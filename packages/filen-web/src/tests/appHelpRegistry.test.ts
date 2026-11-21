import { describe, expect, it } from "vitest"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { APP_HELP } from "@filen/shared/assistant"
import { EN_CATALOGS } from "@/lib/i18n/catalog"

const SRC = fileURLToPath(new URL("..", import.meta.url))

// Every description key the Settings pages render: the settings routes, the settings feature's components and every
// component they import from another feature (the desktop app lock and downloads rows). Whatever namespace a key
// lives in (settings, auth for the security rows, desktop, common), a literal ending in "Description" is one.
function settingsSources(): Map<string, string> {
	const sources = new Map<string, string>()
	const queue: string[] = []

	function walk(directory: string): void {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name)

			if (entry.isDirectory()) {
				walk(path)
			} else if (/\.tsx?$/.test(entry.name)) {
				queue.push(path)
			}
		}
	}

	walk(join(SRC, "routes/_app/settings"))
	walk(join(SRC, "features/settings/components"))

	while (queue.length > 0) {
		const path = queue.pop()

		if (path === undefined || sources.has(path)) {
			continue
		}

		const source = readFileSync(path, "utf8")

		sources.set(path, source)

		for (const [, imported] of source.matchAll(/from "@\/(features\/[^"]+\/components\/[^"]+)"/g)) {
			const base = join(SRC, imported ?? "")
			const file = [`${base}.tsx`, `${base}.ts`].find(candidate => existsSync(candidate))

			if (file !== undefined) {
				queue.push(file)
			}
		}
	}

	return sources
}

function bareKey(key: string): string {
	return key.slice(key.indexOf(":") + 1)
}

// Description keys that explain no setting of their own: dialog and empty-state copy, and the descriptions of groups
// whose every row has its own entry.
const HELP_EXCLUDED: ReadonlySet<string> = new Set([
	"settingsTwoFactorSetUpDescription",
	"settingsOfficeSavedSignaturesDialogDescription",
	"settingsBillingWithdrawDescription",
	"settingsBillingSubscriptionsEmptyDescription",
	"settingsBillingInvoicesEmptyDescription",
	"eventsEmptyDescription",
	"eventsNoResultsDescription",
	"eventsNoResultsLoadedDescription",
	"pinRemoveDescription",
	"pinRulesDescription",
	"settingsOfficeGeneralDescription",
	"settingsOfficeProofingDescription",
	"settingsOfficeRegionalDescription",
	"settingsOfficePdfDescription",
	"settingsOfficeWordDescription",
	"settingsOfficeLayoutDescription",
	"settingsRailDescription",
	"settingsDriveMemoryDescription",
	"settingsAdvancedArchiveDescription",
	"settingsAdvancedUploadsDescription",
	"settingsAdvancedDriveDescription",
	"storageGroupCachesDescription"
])

const sources = settingsSources()
const corpus = [...sources.values()].join("\n")
const rendered = new Set([...corpus.matchAll(/"((?:[a-z]+:)?[a-zA-Z]+Description)"/g)].map(([, key]) => bareKey(key ?? "")))

describe("app_help registry drift", () => {
	it("scans the settings pages and the rows they borrow", () => {
		expect(rendered.size).toBeGreaterThan(50)
		expect([...sources.keys()].some(path => path.endsWith("features/desktop/components/appLockSettings.tsx"))).toBe(true)
	})

	it("covers every description the settings pages render", () => {
		const registered = new Set(APP_HELP.map(entry => bareKey(entry.descriptionKey)))
		const missing = [...rendered].filter(key => !registered.has(key) && !HELP_EXCLUDED.has(key))

		expect(missing).toEqual([])
	})

	it("holds no entry or exclusion the settings pages no longer render", () => {
		expect(APP_HELP.map(entry => bareKey(entry.descriptionKey)).filter(key => !rendered.has(key))).toEqual([])
		expect([...HELP_EXCLUDED].filter(key => !rendered.has(key))).toEqual([])
		expect(APP_HELP.filter(entry => HELP_EXCLUDED.has(bareKey(entry.descriptionKey))).map(entry => entry.id)).toEqual([])
	})

	it("names keys that exist in their English namespaces, as plain or plural keys", () => {
		const catalogs: Readonly<Record<string, Readonly<Record<string, string>>>> = EN_CATALOGS

		for (const entry of APP_HELP) {
			for (const key of [entry.titleKey, entry.descriptionKey]) {
				const [namespace = "", name = ""] = key.split(":")

				expect(catalogs[namespace]?.[name] ?? catalogs[namespace]?.[`${name}_other`], `${entry.id}: ${key}`).toBeTypeOf("string")
			}
		}
	})

	it("anchors every entry on a settings page", () => {
		expect(APP_HELP.filter(entry => !corpus.includes(`"${entry.id}"`)).map(entry => entry.id)).toEqual([])
	})
})
