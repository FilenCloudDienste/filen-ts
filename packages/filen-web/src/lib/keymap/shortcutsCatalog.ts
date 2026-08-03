import type { CommonKey } from "@/lib/i18n"
import type { ActionScope, ResolvedAction } from "@/lib/keymap/registry"

// The namespaces `ActionDef.descriptionKey` prefixes can name — what the shortcuts UI loads via
// useTranslation. A prefix admitted by the type but missing here renders as a raw key, so the two
// are kept in step by a runtime test.
export const SHORTCUT_NAMESPACES = ["common", "drive", "notes", "chats", "photos", "audio", "preview", "contacts"] as const

// Display order of the scope groups. A plain array, so a scope missing from it makes its whole group
// vanish from BOTH surfaces silently — covered by an exhaustiveness assertion in the tests.
export const SHORTCUT_SCOPE_ORDER: readonly ActionScope[] = ["global", "drive", "photos", "notes", "chats", "contacts", "editor", "audio"]

// Reuses the existing module labels rather than minting duplicates; only the three scopes with no
// module of their own get a dedicated key.
export const SHORTCUT_SCOPE_LABEL_KEYS: Record<ActionScope, CommonKey> = {
	global: "shortcutsScopeGlobal",
	drive: "moduleDrive",
	photos: "modulePhotos",
	notes: "moduleNotes",
	chats: "moduleChats",
	contacts: "moduleContacts",
	editor: "shortcutsScopeEditor",
	audio: "shortcutsScopeAudio"
}

export interface ShortcutGroup {
	scope: ActionScope
	labelKey: CommonKey
	actions: readonly ResolvedAction[]
}

// Buckets actions by scope, emits the groups in SHORTCUT_SCOPE_ORDER and sorts within a group by id
// so the rendering is deterministic regardless of module import order. UNBOUND actions are kept:
// they are exactly the ones a user needs this surface to reach, and the rebind row is where that
// happens. A scope with no actions produces no group.
export function groupShortcuts(actions: readonly ResolvedAction[]): readonly ShortcutGroup[] {
	const byScope = new Map<ActionScope, ResolvedAction[]>()

	for (const action of actions) {
		const bucket = byScope.get(action.scope)

		if (bucket) {
			bucket.push(action)
		} else {
			byScope.set(action.scope, [action])
		}
	}

	const groups: ShortcutGroup[] = []

	for (const scope of SHORTCUT_SCOPE_ORDER) {
		const bucket = byScope.get(scope)

		if (bucket === undefined || bucket.length === 0) {
			continue
		}

		groups.push({
			scope,
			labelKey: SHORTCUT_SCOPE_LABEL_KEYS[scope],
			actions: [...bucket].sort((a, b) => a.id.localeCompare(b.id))
		})
	}

	return groups
}
