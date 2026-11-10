import { type } from "arktype"
import { normalizeCombo, UNBOUND_COMBO } from "@filen/shared/keymap"
import type { ResolvedAction } from "@/lib/keymap/registry"
import { keymapOverridesSchema, type KeymapRecord } from "@/lib/keymap/storage"

// The file Settings → Keyboard exports and imports: the user's overrides by action id ("none" turns an action off)
// and the single-key switch. `mod` is Cmd on a Mac and Ctrl elsewhere, so most bindings mean the same everywhere;
// `meta` is Cmd on a Mac but the Windows key elsewhere.
export const KEYMAP_EXPORT_KIND = "filen-keymap"
export const KEYMAP_EXPORT_VERSION = 1

export const keymapExportSchema = type({
	kind: `'${KEYMAP_EXPORT_KIND}'`,
	version: "1",
	overrides: keymapOverridesSchema,
	"characterKeys?": "boolean"
})

// Bigger than any real export by orders of magnitude; read no further.
export const KEYMAP_IMPORT_MAX_BYTES = 256 * 1024

export function keymapExport(record: KeymapRecord): string {
	return `${JSON.stringify(
		{ kind: KEYMAP_EXPORT_KIND, version: KEYMAP_EXPORT_VERSION, characterKeys: record.characterKeys, overrides: record.overrides },
		null,
		"\t"
	)}\n`
}

export interface KeymapImportChange {
	id: string
	// The combo in effect before ("" when unbound) and after.
	before: string
	after: string
}

export interface KeymapImportPlan {
	// Canonical combos by id, only for actions this version has and whose binding the import changes.
	overrides: Record<string, string>
	changes: KeymapImportChange[]
	// Entries naming no action of this version, or holding no combo.
	skipped: number
	characterKeys: boolean | undefined
}

// What importing `text` would change against `actions` (the catalog on this platform); null when the text is not an
// export. Merges: actions the file does not mention keep their binding.
export function planKeymapImport(text: string, actions: readonly ResolvedAction[], current: KeymapRecord): KeymapImportPlan | null {
	let parsed: unknown

	try {
		parsed = JSON.parse(text)
	} catch {
		return null
	}

	const file = keymapExportSchema(parsed)

	if (file instanceof type.errors) {
		return null
	}

	const byId = new Map(actions.map(action => [action.id, action]))
	const overrides: Record<string, string> = {}
	const changes: KeymapImportChange[] = []
	let skipped = 0

	for (const [id, combo] of Object.entries(file.overrides)) {
		const action = byId.get(id)
		const canonical = combo === UNBOUND_COMBO ? combo : normalizeCombo(combo)

		if (action === undefined || canonical.length === 0) {
			skipped++

			continue
		}

		const after = canonical === UNBOUND_COMBO ? "" : canonical

		if (after !== action.combo) {
			overrides[id] = canonical
			changes.push({ id, before: action.combo, after })
		}
	}

	const characterKeys = file.characterKeys === undefined || file.characterKeys === current.characterKeys ? undefined : file.characterKeys

	return { overrides, changes, skipped, characterKeys }
}
