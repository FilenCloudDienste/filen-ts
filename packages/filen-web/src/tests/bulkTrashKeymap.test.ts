import { beforeEach, describe, expect, it, vi } from "vitest"

// Same isolation approach as photosKeymap.test.ts: registry.ts is a Map-backed singleton, so a fresh
// dynamic import per test avoids duplicate-id collisions across `it()` blocks.
const { kvStore } = vi.hoisted(() => ({ kvStore: new Map<string, unknown>() }))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(kvStore.get(key) ?? null),
	kvSetJson: (key: string, value: unknown) => {
		kvStore.set(key, value)

		return Promise.resolve()
	}
}))

const DRIVE_TRASH = { id: "drive.trash", defaultCombo: "delete,backspace", scope: "drive", descriptionKey: "driveCommandTrash" } as const
const NOTES_TRASH = { id: "notes.trash", defaultCombo: "delete,backspace", scope: "notes", descriptionKey: "notesCommandTrash" } as const
const PHOTOS_TRASH = {
	id: "photos.trash",
	defaultCombo: "delete,backspace",
	scope: "photos",
	descriptionKey: "driveCommandTrash"
} as const
const DRIVE_CLEAR = {
	id: "drive.clearSelection",
	defaultCombo: "escape",
	scope: "drive",
	descriptionKey: "driveCommandClearSelection"
} as const
const CONTACTS_CLEAR = {
	id: "contacts.clearSelection",
	defaultCombo: "escape",
	scope: "contacts",
	descriptionKey: "contactsCommandClearSelection"
} as const

async function freshRegistry() {
	vi.resetModules()

	return import("@/lib/keymap/registry")
}

beforeEach(() => {
	kvStore.clear()
})

// Mirrors the real module-scope registrations in directoryListing.tsx / notesSidebar.tsx /
// photoGrid.tsx / contactsList.tsx. What is worth locking down is that these bindings share ONE combo
// by design across mutually exclusive routes — a drift here would read as a collision rather than the
// deliberate reuse it is, and `scope` is still inert (useAction.ts) so nothing else enforces it.
describe("keymap registry — bulk-trash bindings", () => {
	it("registers notes.trash and photos.trash on drive.trash's own combo", async () => {
		const { registerAction, comboFor } = await freshRegistry()

		registerAction(DRIVE_TRASH)
		registerAction(NOTES_TRASH)
		registerAction(PHOTOS_TRASH)

		expect(comboFor("notes.trash")).toBe("delete,backspace")
		expect(comboFor("photos.trash")).toBe("delete,backspace")
		expect(comboFor("notes.trash")).toBe(comboFor("drive.trash"))
	})

	it("keeps the three bulk-trash bindings distinct ids, so a scope-aware future can separate them", async () => {
		const { registerAction } = await freshRegistry()

		registerAction(DRIVE_TRASH)
		registerAction(NOTES_TRASH)

		expect(() => {
			registerAction(NOTES_TRASH)
		}).toThrow()
	})

	it("registers contacts.clearSelection on the same Escape every other surface clears with", async () => {
		const { registerAction, comboFor } = await freshRegistry()

		registerAction(DRIVE_CLEAR)
		registerAction(CONTACTS_CLEAR)

		expect(comboFor("contacts.clearSelection")).toBe("escape")
		expect(comboFor("contacts.clearSelection")).toBe(comboFor("drive.clearSelection"))
	})

	it("lets a user override the notes bulk-trash combo without touching drive's", async () => {
		const { registerAction, comboFor, setUserCombo } = await freshRegistry()

		registerAction(DRIVE_TRASH)
		registerAction(NOTES_TRASH)
		await setUserCombo("notes.trash", "mod+backspace")

		expect(comboFor("notes.trash")).toBe("mod+backspace")
		expect(comboFor("drive.trash")).toBe("delete,backspace")
	})
})
