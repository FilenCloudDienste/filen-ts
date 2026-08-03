import { describe, expect, it } from "vitest"
import { resolveSidebarKind, SIDEBAR_LABEL_KEY, type SidebarKind } from "@/features/shell/lib/appShell.logic"

const ALL_KINDS: SidebarKind[] = ["chats", "notes", "settings", "contacts", "drive"]

describe("resolveSidebarKind", () => {
	it("matches the bare /chats index", () => {
		expect(resolveSidebarKind("/chats")).toBe("chats")
	})

	it("matches a nested chat thread", () => {
		expect(resolveSidebarKind("/chats/1a2b3c4d-0000-0000-0000-000000000000")).toBe("chats")
	})

	it("matches the bare /notes index", () => {
		expect(resolveSidebarKind("/notes")).toBe("notes")
	})

	it("matches a nested note", () => {
		expect(resolveSidebarKind("/notes/1a2b3c4d-0000-0000-0000-000000000000")).toBe("notes")
	})

	it("matches the bare /settings index", () => {
		expect(resolveSidebarKind("/settings")).toBe("settings")
	})

	it("matches a settings section", () => {
		expect(resolveSidebarKind("/settings/security")).toBe("settings")
	})

	it("matches /contacts", () => {
		expect(resolveSidebarKind("/contacts")).toBe("contacts")
	})

	it("matches the drive root and a nested directory", () => {
		expect(resolveSidebarKind("/drive")).toBe("drive")
		expect(resolveSidebarKind("/drive/a/b")).toBe("drive")
	})

	// The routes with no contextual sidebar of their own all fall through to the drive panel together —
	// asserted in ONE case so flipping that product decision touches one line here and one in the resolver.
	it("falls through to the drive panel on /transfers, /playlists and /photos", () => {
		expect(resolveSidebarKind("/transfers")).toBe("drive")
		expect(resolveSidebarKind("/playlists")).toBe("drive")
		expect(resolveSidebarKind("/photos")).toBe("drive")
	})

	it("keeps the drive panel on every drive variant", () => {
		for (const pathname of ["/recents", "/favorites", "/trash", "/links", "/shared-in", "/shared-out", "/shared-in/a/b"]) {
			expect(resolveSidebarKind(pathname)).toBe("drive")
		}
	})

	// Exact-or-slash, never a bare prefix: a future "/notes-archive" route must not steal the notes panel.
	it("does not match on a bare name prefix", () => {
		for (const pathname of ["/notes-archive", "/chatsomething", "/settingsx", "/contacts-list"]) {
			expect(resolveSidebarKind(pathname)).toBe("drive")
		}
	})

	it("falls through on the root path and an empty string", () => {
		expect(resolveSidebarKind("/")).toBe("drive")
		expect(resolveSidebarKind("")).toBe("drive")
	})
})

describe("SIDEBAR_LABEL_KEY", () => {
	it("labels every sidebar kind", () => {
		for (const kind of ALL_KINDS) {
			expect(SIDEBAR_LABEL_KEY[kind].length).toBeGreaterThan(0)
		}
	})

	it("gives each kind its own label key", () => {
		expect(new Set(Object.values(SIDEBAR_LABEL_KEY)).size).toBe(ALL_KINDS.length)
	})
})
