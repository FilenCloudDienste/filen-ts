import { describe, it, expect } from "vitest"

import { common } from "@/locales/en/common"
import { auth } from "@/locales/en/auth"
import { appearance } from "@/locales/en/appearance"
import { chats } from "@/locales/en/chats"
import { contacts } from "@/locales/en/contacts"
import { drive } from "@/locales/en/drive"
import { drivePreview } from "@/locales/en/drivePreview"
import { errors } from "@/locales/en/errors"
import { media } from "@/locales/en/media"
import { misc } from "@/locales/en/misc"
import { notes } from "@/locales/en/notes"
import { security } from "@/locales/en/security"
import { settings } from "@/locales/en/settings"
import { sort } from "@/locales/en/sort"
import { transfers } from "@/locales/en/transfers"
import { en } from "@/locales/en"

// All 15 catalogs in spread order (mirrors src/locales/en/index.ts)
const ALL_CATALOGS: Record<string, Record<string, string>> = {
	common,
	appearance,
	auth,
	chats,
	contacts,
	drive,
	drivePreview,
	errors,
	media,
	misc,
	notes,
	security,
	settings,
	sort,
	transfers
}

// Plural/context suffix tokens that i18next appends to base keys (Risk 1 in common.ts)
const PLURAL_CONTEXT_SUFFIXES = ["_one", "_other", "_zero", "_two", "_few", "_many", "_male", "_female"] as const

// Intentional plural key pairs declared as `<base>_one` / `<base>_other`; these are
// genuine i18next plural declarations and must NOT be flagged by the suffix guard.
const INTENTIONAL_PLURAL_KEYS = new Set([
	"selected_one",
	"selected_other",
	"new_messages_since_one",
	"new_messages_since_other",
	"select_n_items_one",
	"select_n_items_other",
	"photos_per_row_one",
	"photos_per_row_other",
	"tracks_updated_one",
	"tracks_updated_other",
	"select_n_playlists_one",
	"select_n_playlists_other",
	"tag_notes_count_and_date_one",
	"tag_notes_count_and_date_other",
	"offline_files_count_one",
	"offline_files_count_other",
	"offline_dirs_count_one",
	"offline_dirs_count_other",
	"transfers_active_one",
	"transfers_active_other",
	"transfers_progress_one",
	"transfers_progress_other"
])

describe("auth catalog", () => {
	// ── Structural key-uniqueness across all 15 catalogs ─────────────────────

	it("merges all 15 catalogs into the flat en catalog without any key collisions", () => {
		// Build a map of key → first catalog that declared it, then check for any duplicate
		const keyOrigin: Record<string, string> = {}
		const collisions: Array<{ key: string; first: string; second: string }> = []

		for (const [catalogName, catalog] of Object.entries(ALL_CATALOGS)) {
			for (const key of Object.keys(catalog)) {
				if (keyOrigin[key] !== undefined) {
					collisions.push({ key, first: keyOrigin[key]!, second: catalogName })
				} else {
					keyOrigin[key] = catalogName
				}
			}
		}

		// A non-empty array here means a silent runtime overwrite; report which pairs collide
		expect(collisions).toEqual([])
	})

	it("every key in every catalog is reachable in the merged en object", () => {
		for (const [catalogName, catalog] of Object.entries(ALL_CATALOGS)) {
			for (const key of Object.keys(catalog)) {
				expect(en, `key "${key}" from catalog "${catalogName}" missing in en`).toHaveProperty(key)
			}
		}
	})

	// ── Link-placeholder structural well-formedness ───────────────────────────

	it("renders the split-sentence link strings with exactly one well-formed <link>…</link> pair", () => {
		const linkStrings = {
			dont_have_an_account: auth.dont_have_an_account,
			already_have_an_account: auth.already_have_an_account
		}

		for (const [key, value] of Object.entries(linkStrings)) {
			const openCount = (value.match(/<link>/g) ?? []).length
			const closeCount = (value.match(/<\/link>/g) ?? []).length
			const openIndex = value.indexOf("<link>")
			const closeIndex = value.indexOf("</link>")
			const innerText = value.slice(openIndex + "<link>".length, closeIndex)

			expect(openCount, `${key}: expected exactly one <link> tag`).toBe(1)
			expect(closeCount, `${key}: expected exactly one </link> tag`).toBe(1)
			expect(openIndex, `${key}: <link> must appear before </link>`).toBeLessThan(closeIndex)
			expect(innerText.trim().length, `${key}: text inside <link>…</link> must be non-empty`).toBeGreaterThan(0)
		}
	})

	// ── Plural/context suffix safety (Risk 1 in common.ts) ───────────────────

	it("no non-plural key in any catalog ends in an i18next plural/context suffix token", () => {
		const violations: Array<{ catalog: string; key: string }> = []

		for (const [catalogName, catalog] of Object.entries(ALL_CATALOGS)) {
			for (const key of Object.keys(catalog)) {
				if (INTENTIONAL_PLURAL_KEYS.has(key)) continue
				for (const suffix of PLURAL_CONTEXT_SUFFIXES) {
					if (key.endsWith(suffix)) {
						violations.push({ catalog: catalogName, key })
					}
				}
			}
		}

		// A non-empty array means a key accidentally ends with a suffix i18next would
		// interpret as a plural/context form, silently hiding the base key at runtime.
		expect(violations).toEqual([])
	})

	// ── Locale JSON completeness ──────────────────────────────────────────────

	it.todo(
		"every non-English locale JSON file contains all keys present in the en catalog — " +
			"3 keys (setup_failed_title, setup_failed_description, try_again) are missing from all 25 non-English locale " +
			"files (bn, cs, da, de, es, fi, fr, hi, hu, id, it, ja, ko, nl, no, pl, pt, ro, ru, sv, th, tr, uk, vi, zh) " +
			"AND from src/locales/.en-snapshot.json — these keys were added to src/locales/en/misc.ts after the last " +
			"locale sync — to resolve: set ANTHROPIC_API_KEY and run `npm run translate-i18n` (DELTA mode will detect " +
			"the missing keys automatically and fill all 25 files + update the snapshot)"
	)
})
