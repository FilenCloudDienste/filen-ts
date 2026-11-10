import {
	availableOn,
	CURRENT_PLATFORM,
	registerAction,
	resolveAction,
	useKeymapRecord,
	type ActionDef,
	type KeymapPlatform,
	type KeymapRecord,
	type ResolvedAction
} from "@/lib/keymap/registry"
import { conflictsByAction } from "@/lib/keymap/conflicts"
import { groupShortcuts, type ShortcutGroup } from "@/lib/keymap/shortcutsCatalog"
import { APP_ACTIONS } from "@/features/shell/lib/keymap"
import { DRIVE_ACTIONS } from "@/features/drive/lib/keymap"
import { NOTES_ACTIONS } from "@/features/notes/lib/keymap"
import { CHATS_ACTIONS } from "@/features/chats/lib/keymap"
import { CONTACTS_ACTIONS } from "@/features/contacts/lib/keymap"
import { PHOTOS_ACTIONS } from "@/features/photos/lib/keymap"
import { PREVIEW_ACTIONS } from "@/features/preview/lib/keymap"
import { AUDIO_ACTIONS } from "@/features/audio/lib/keymap"
import { VIDEOS_ACTIONS } from "@/features/videos/lib/keymap"
import { PRESENTATION_ACTIONS } from "@/features/presentation/lib/keymap"
import { PLAYLISTS_ACTIONS } from "@/features/audio/lib/playlistKeymap"
import { TRANSFERS_ACTIONS } from "@/features/transfers/lib/keymap"
import { SYNC_ACTIONS } from "@/features/sync/lib/keymap"
import { MOUNTS_ACTIONS } from "@/features/mounts/lib/keymap"
import { PUBLIC_LINKS_ACTIONS } from "@/features/publicLinks/lib/keymap"
import { SETTINGS_ACTIONS } from "@/features/settings/lib/keymap"
import { MEDIA_ACTIONS } from "@/lib/media/keymap"
import { ARCHIVE_ACTIONS } from "@/features/archive/lib/keymap"
import { DOCX_ACTIONS } from "@/features/preview/lib/docxKeymap"
import { SHEET_ACTIONS } from "@/features/spreadsheet/lib/keymap"
import { OFFICE_ACTIONS } from "@/features/office/lib/keymap"

// The app's complete action set, assembled eagerly from each feature's data-only keymap module, so the
// shortcuts catalog never depends on which feature components have mounted. The defs are plain objects
// whose only import is an erased type; the handlers stay in their own components.
export const ALL_ACTIONS: readonly ActionDef[] = [
	...APP_ACTIONS,
	...DRIVE_ACTIONS,
	...NOTES_ACTIONS,
	...CHATS_ACTIONS,
	...CONTACTS_ACTIONS,
	...PHOTOS_ACTIONS,
	...VIDEOS_ACTIONS,
	...PREVIEW_ACTIONS,
	...PRESENTATION_ACTIONS,
	...AUDIO_ACTIONS,
	...PLAYLISTS_ACTIONS,
	...TRANSFERS_ACTIONS,
	...SYNC_ACTIONS,
	...MOUNTS_ACTIONS,
	...PUBLIC_LINKS_ACTIONS,
	...SETTINGS_ACTIONS,
	...MEDIA_ACTIONS,
	...ARCHIVE_ACTIONS,
	...DOCX_ACTIONS,
	...SHEET_ACTIONS,
	...OFFICE_ACTIONS
]

let registered = false

// Called once from main.tsx before the first render, so `comboFor` is correct for every action from
// the very first paint — including on the pre-auth surface. Idempotent: one guarded entry point
// replaces the per-module registrations whose Fast-Refresh re-evaluation used to throw on the
// duplicate-id check.
export function registerAllActions(): void {
	if (registered) {
		return
	}

	registered = true

	for (const def of ALL_ACTIONS) {
		registerAction(def)
	}
}

export interface ShortcutCatalog {
	actions: readonly ResolvedAction[]
	groups: readonly ShortcutGroup[]
	// Each action sharing a keystroke with others that can be mounted with it, and those others.
	conflicts: ReadonlyMap<string, readonly ResolvedAction[]>
	byId: ReadonlyMap<string, ResolvedAction>
}

// Every action on a platform with its binding, grouped, and the conflicts between them.
export function shortcutCatalog(record: KeymapRecord, platform: KeymapPlatform): ShortcutCatalog {
	const actions = ALL_ACTIONS.filter(def => availableOn(def, platform)).map(def => resolveAction(def, record.overrides, platform))

	return {
		actions,
		groups: groupShortcuts(actions),
		conflicts: conflictsByAction(actions, platform.mac),
		byId: new Map(actions.map(action => [action.id, action]))
	}
}

// One catalog per record: it is rebuilt only when a binding changes, never per keystroke in the search field.
const catalogs = new WeakMap<KeymapRecord, ShortcutCatalog>()

export function currentCatalog(record: KeymapRecord): ShortcutCatalog {
	let catalog = catalogs.get(record)

	if (catalog === undefined) {
		catalog = shortcutCatalog(record, CURRENT_PLATFORM)
		catalogs.set(record, catalog)
	}

	return catalog
}

// Subscribed: the catalog under the live record.
export function useShortcutCatalog(): ShortcutCatalog {
	return currentCatalog(useKeymapRecord())
}
