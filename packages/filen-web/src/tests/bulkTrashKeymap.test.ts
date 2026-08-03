import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ActionDef } from "@/lib/keymap/registry"
import { DRIVE_ACTIONS } from "@/features/drive/lib/keymap"
import { NOTES_ACTIONS } from "@/features/notes/lib/keymap"
import { PHOTOS_ACTIONS } from "@/features/photos/lib/keymap"
import { CONTACTS_ACTIONS } from "@/features/contacts/lib/keymap"

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

// Reads the REAL defs rather than mirroring them, so a combo changed at the source fails here
// instead of silently drifting away from a copy.
function defFor(actions: readonly ActionDef[], id: string): ActionDef {
	const def = actions.find(action => action.id === id)

	if (!def) {
		throw new Error(`missing action def: ${id}`)
	}

	return def
}

const DRIVE_TRASH = defFor(DRIVE_ACTIONS, "drive.trash")
const NOTES_TRASH = defFor(NOTES_ACTIONS, "notes.trash")
const PHOTOS_TRASH = defFor(PHOTOS_ACTIONS, "photos.trash")
const DRIVE_CLEAR = defFor(DRIVE_ACTIONS, "drive.clearSelection")
const CONTACTS_CLEAR = defFor(CONTACTS_ACTIONS, "contacts.clearSelection")

async function freshRegistry() {
	vi.resetModules()

	return import("@/lib/keymap/registry")
}

beforeEach(() => {
	kvStore.clear()
})

// What is worth locking down is that these bindings share ONE combo BY DESIGN across mutually
// exclusive routes — a drift here would read as a collision rather than the deliberate reuse it is,
// and scope carries no runtime isolation (useAction.ts).
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
