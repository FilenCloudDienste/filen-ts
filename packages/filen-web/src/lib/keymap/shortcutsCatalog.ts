import { combosOverlap } from "@filen/shared/keymap"
import type { CommonKey, SettingsKey } from "@/lib/i18n"
import type { EnNamespace } from "@/lib/i18n/catalog"
import type { ActionScope, ResolvedAction, ShortcutSection } from "@/lib/keymap/registry"

// The namespaces `ActionDef.descriptionKey` and `hintKey` prefixes can name (registry.ts derives the type from this
// list) and what the shortcuts UI loads via useTranslation, so the two cannot drift.
export const SHORTCUT_NAMESPACES = [
	"common",
	"settings",
	"drive",
	"notes",
	"chats",
	"photos",
	"audio",
	"preview",
	"contacts",
	"videos",
	"transfers",
	"sync",
	"mounts",
	"publicLinks"
] as const satisfies readonly EnNamespace[]

// Display order of the scope groups. A plain array, so a scope missing from it makes its whole group vanish from BOTH
// surfaces silently — covered by an exhaustiveness assertion in the tests.
export const SHORTCUT_SCOPE_ORDER: readonly ActionScope[] = [
	"global",
	"drive",
	"photos",
	"videos",
	"notes",
	"chats",
	"contacts",
	"editor",
	"audio",
	"media",
	"playlists",
	"transfers",
	"sync",
	"mounts",
	"publicLinks",
	"settings"
]

// Reuses the existing module labels rather than minting duplicates; only the three scopes with no module of their own
// get a dedicated key.
export const SHORTCUT_SCOPE_LABEL_KEYS: Record<ActionScope, CommonKey> = {
	global: "shortcutsScopeGlobal",
	drive: "moduleDrive",
	photos: "modulePhotos",
	videos: "moduleVideos",
	notes: "moduleNotes",
	chats: "moduleChats",
	contacts: "moduleContacts",
	editor: "shortcutsScopeEditor",
	audio: "shortcutsScopeAudio",
	playlists: "modulePlaylists",
	transfers: "moduleTransfers",
	sync: "moduleSync",
	mounts: "moduleMounts",
	publicLinks: "shortcutsScopePublicLinks",
	settings: "settings",
	media: "shortcutsScopeMedia"
}

// The editor's sub-groups in the order a user meets them, after the actions every editor shares.
export const SHORTCUT_SECTION_ORDER: readonly ShortcutSection[] = [
	"code",
	"viewer",
	"imageEditor",
	"word",
	"sheet",
	"presentation",
	"presentationObjects",
	"presentationText",
	"slideshow",
	"archive"
]

export const SHORTCUT_SECTION_LABEL_KEYS: Record<ShortcutSection, SettingsKey> = {
	viewer: "keyboardSectionViewer",
	imageEditor: "keyboardSectionImageEditor",
	code: "keyboardSectionCode",
	presentation: "keyboardSectionPresentation",
	presentationObjects: "keyboardSectionPresentationObjects",
	presentationText: "keyboardSectionPresentationText",
	slideshow: "keyboardSectionSlideshow",
	word: "keyboardSectionWord",
	sheet: "keyboardSectionSheet",
	archive: "keyboardSectionArchive"
}

export interface ShortcutGroup {
	// "drive", or "editor.presentation" for a sub-group.
	key: string
	scope: ActionScope
	section: ShortcutSection | null
	labelKey: CommonKey
	sectionLabelKey: SettingsKey | null
	actions: readonly ResolvedAction[]
}

function groupKey(scope: ActionScope, section: ShortcutSection | null): string {
	return section === null ? scope : `${scope}.${section}`
}

// Buckets actions by scope and section in display order. Within a group the actions keep the order their feature
// lists them in, which is task order (select, open, edit, remove), not alphabetical. UNBOUND actions are kept: they
// are exactly the ones a user needs this surface to reach. A group with no actions produces no group.
export function groupShortcuts(actions: readonly ResolvedAction[]): readonly ShortcutGroup[] {
	const buckets = new Map<string, ResolvedAction[]>()

	for (const action of actions) {
		const key = groupKey(action.scope, action.section ?? null)
		const bucket = buckets.get(key)

		if (bucket) {
			bucket.push(action)
		} else {
			buckets.set(key, [action])
		}
	}

	const groups: ShortcutGroup[] = []

	for (const scope of SHORTCUT_SCOPE_ORDER) {
		for (const section of [null, ...SHORTCUT_SECTION_ORDER]) {
			const key = groupKey(scope, section)
			const bucket = buckets.get(key)

			if (bucket === undefined || bucket.length === 0) {
				continue
			}

			groups.push({
				key,
				scope,
				section,
				labelKey: SHORTCUT_SCOPE_LABEL_KEYS[scope],
				sectionLabelKey: section === null ? null : SHORTCUT_SECTION_LABEL_KEYS[section],
				actions: bucket
			})
		}
	}

	return groups
}

export type ShortcutFilter = "all" | "changed" | "conflicts" | "unset"

export function matchesFilter(action: ResolvedAction, filter: ShortcutFilter, conflicts: ReadonlyMap<string, unknown>): boolean {
	switch (filter) {
		case "all":
			return true
		case "changed":
			return action.overridden
		case "conflicts":
			return conflicts.has(action.id)
		case "unset":
			return action.combo.length === 0
	}
}

export function filterCounts(
	actions: readonly ResolvedAction[],
	conflicts: ReadonlyMap<string, unknown>
): Readonly<Record<Exclude<ShortcutFilter, "all">, number>> {
	let changed = 0
	let unset = 0

	for (const action of actions) {
		if (action.overridden) changed++
		if (action.combo.length === 0) unset++
	}

	return { changed, conflicts: conflicts.size, unset }
}

export interface ShortcutQuery {
	// Lowercased already; matched against the action's name, its hint and its group's name.
	text: string
	// A recorded chord: only the actions it fires (by keystroke, as the conflict check compares).
	keys: string | null
	filter: ShortcutFilter
}

// The list's groups under a search and a filter. `label` names an action, `groupLabel` a group (translated by the
// caller), both lowercased.
export function searchShortcuts(
	groups: readonly ShortcutGroup[],
	query: ShortcutQuery,
	conflicts: ReadonlyMap<string, unknown>,
	label: (action: ResolvedAction) => string,
	groupLabel: (group: ShortcutGroup) => string,
	mac: boolean
): readonly ShortcutGroup[] {
	if (query.text === "" && query.keys === null && query.filter === "all") {
		return groups
	}

	const out: ShortcutGroup[] = []

	for (const group of groups) {
		const groupMatches = query.text !== "" && groupLabel(group).includes(query.text)
		const actions = group.actions.filter(
			action =>
				matchesFilter(action, query.filter, conflicts) &&
				(query.keys === null || combosOverlap(action.combo, query.keys, mac)) &&
				(query.text === "" || groupMatches || label(action).includes(query.text))
		)

		if (actions.length > 0) {
			out.push({ ...group, actions })
		}
	}

	return out
}
