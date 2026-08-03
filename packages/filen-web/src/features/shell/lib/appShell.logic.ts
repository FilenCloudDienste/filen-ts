import { type CommonKey } from "@/lib/i18n"

export type SidebarKind = "chats" | "notes" | "settings" | "contacts" | "drive"

// The drive panel is the app's PERSISTENT navigation, not a drive-only accessory: every route without
// a contextual sidebar of its own (/transfers, /playlists, /photos, and every drive variant —
// /recents, /favorites, /trash, /links, /shared-in, /shared-out) keeps it, so the shell's geometry
// never jumps width between rail destinations and the storage meter stays reachable app-wide.
export function resolveSidebarKind(pathname: string): SidebarKind {
	if (pathname === "/chats" || pathname.startsWith("/chats/")) {
		return "chats"
	}

	if (pathname === "/notes" || pathname.startsWith("/notes/")) {
		return "notes"
	}

	if (pathname === "/settings" || pathname.startsWith("/settings/")) {
		return "settings"
	}

	if (pathname === "/contacts") {
		return "contacts"
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
	drive: "moduleDrive"
}
