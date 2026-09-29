import { type CommonKey } from "@/lib/i18n"

// A section root or any route nested under it.
export function pathIsUnder(pathname: string, root: string): boolean {
	return pathname === root || pathname.startsWith(`${root}/`)
}

export type SidebarKind = "chats" | "notes" | "settings" | "contacts" | "playlists" | "drive"

// The drive panel is the app's PERSISTENT navigation, not a drive-only accessory: every route without
// a contextual sidebar of its own (/transfers, /photos, and every drive variant — /recents,
// /favorites, /trash, /links, /shared-in, /shared-out) keeps it, so the shell's geometry
// never jumps width between rail destinations and the storage meter stays reachable app-wide.
export function resolveSidebarKind(pathname: string): SidebarKind {
	if (pathIsUnder(pathname, "/chats")) {
		return "chats"
	}

	if (pathIsUnder(pathname, "/notes")) {
		return "notes"
	}

	if (pathIsUnder(pathname, "/settings")) {
		return "settings"
	}

	if (pathname === "/contacts") {
		return "contacts"
	}

	if (pathname === "/playlists") {
		return "playlists"
	}

	return "drive"
}

// Accessible name for the narrow-viewport drawer hosting the panel — the module's own existing rail
// label, so no new copy is introduced for a surface that already has a name.
export const SIDEBAR_LABEL_KEY: Record<SidebarKind, CommonKey> = {
	chats: "moduleChats",
	notes: "moduleNotes",
	settings: "settings",
	contacts: "moduleContacts",
	playlists: "modulePlaylists",
	drive: "moduleDrive"
}
