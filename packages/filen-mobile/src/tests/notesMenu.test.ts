import { vi, describe, it, expect } from "vitest"

// NoteType is a NUMERIC enum in the RN uniffi runtime the app actually runs
// (@filen/sdk-rs/src/generated/filen_types.ts: Text=0, Md=1, Code=2, Rich=3, Checklist=4),
// NOT the wasm .d.ts string union. Mirror the numeric ordinals so === comparisons in
// createMenuButtons match the real runtime (matches the sibling notesHeaderMenuBuilders.test.ts).
vi.mock("@filen/sdk-rs", () => {
	const NoteType = {
		Text: 0,
		Md: 1,
		Code: 2,
		Rich: 3,
		Checklist: 4
	}

	return { NoteType }
})

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("@filen/utils", async () => await import("@/tests/mocks/filenUtils"))

vi.mock("@/lib/i18n", () => ({
	t: (key: string) => key,
	default: { t: (key: string) => key }
}))

vi.mock("@/lib/auth", () => ({
	useStringifiedClient: vi.fn().mockReturnValue(null),
	default: { getSdkClients: vi.fn() }
}))

vi.mock("@/features/notes/store/useNotes.store", () => ({
	default: {
		getState: vi.fn(() => ({
			toggleSelectedNote: vi.fn()
		}))
	}
}))

vi.mock("@/features/notes/notes", () => ({
	default: {}
}))

vi.mock("@/lib/prompts", () => ({
	default: { alert: vi.fn(), input: vi.fn() }
}))

vi.mock("@/lib/alerts", () => ({
	default: { error: vi.fn() }
}))

vi.mock("expo-router", () => ({
	router: { push: vi.fn(), back: vi.fn(), canGoBack: vi.fn(() => false) }
}))

vi.mock("@/stores/useApp.store", () => ({
	default: {
		getState: vi.fn(() => ({ pathname: "/" }))
	}
}))

vi.mock("expo-sharing", () => ({
	shareAsync: vi.fn()
}))

vi.mock("expo-clipboard", () => ({
	setStringAsync: vi.fn()
}))

vi.mock("@/lib/serializer", () => ({
	serialize: vi.fn(x => JSON.stringify(x))
}))

vi.mock("@/components/ui/fullScreenLoadingModal", () => ({
	runWithLoading: vi.fn(async (fn: () => Promise<unknown>) => {
		try {
			const data = await fn()

			return { success: true, data }
		} catch (error) {
			return { success: false, error }
		}
	})
}))

vi.mock("@/lib/decryption", () => ({
	noteDisplayTitle: vi.fn((note: { title?: string }) => note.title ?? "Untitled")
}))

// menu.tsx imports from @/components/ui/menu which transitively imports native-only modules.
// We mock @/components/ui/menu to expose only the MenuButton type (nothing is rendered in tests).
vi.mock("@/components/ui/menu", () => ({
	Menu: () => null
}))

vi.mock("@expo/ui/swift-ui", () => ({
	Image: () => null
}))

vi.mock("react-native-ios-context-menu", () => ({
	ContextMenuView: () => null,
	ContextMenuButton: () => null
}))

vi.mock("@react-native-menu/menu", () => ({
	MenuView: () => null
}))

vi.mock("uniwind", () => ({
	withUniwind: (c: unknown) => c,
	useResolveClassNames: () => ({}),
	useUniwind: () => ({ theme: "dark" })
}))

vi.mock("@/hooks/useIsOnline", () => ({
	default: () => true
}))

// @/components/ui/view transitively imports native-only modules (react-native-boost, expo-blur,
// expo-glass-effect, react-native-keyboard-controller, react-native-gesture-handler) that contain
// syntax vitest cannot transform. Mock it to avoid the transformation failure.
vi.mock("@/components/ui/view", () => ({
	default: () => null,
	KeyboardAvoidingView: () => null,
	KeyboardAwareScrollView: () => null,
	KeyboardStickyView: () => null,
	SafeAreaView: () => null
}))

import { NoteType } from "@filen/sdk-rs"
import { createMenuButtons, NOTE_TYPE_OPTIONS, NOTE_TYPE_LABEL_KEY } from "@/features/notes/components/note/menu"
import type { Note } from "@/types"

function makeNote(overrides: Partial<Note> = {}): Note {
	return {
		uuid: "note-1",
		ownerId: 1n,
		lastEditorId: 1n,
		favorite: false,
		pinned: false,
		tags: [],
		noteType: NoteType.Text,
		trash: false,
		archive: false,
		undecryptable: false,
		createdTimestamp: 1000n,
		editedTimestamp: 1000n,
		participants: [],
		...overrides
	} as Note
}

describe("createMenuButtons", () => {
	describe("undecryptable + trashed note", () => {
		it("returns only restore and delete buttons", () => {
			const note = makeNote({ undecryptable: true, trash: true })
			const buttons = createMenuButtons({ note, writeAccess: false, origin: "notes", isOwner: true })
			const ids = buttons.map(b => b.id)

			expect(ids).toEqual(["restore", "delete"])
		})
	})

	describe("undecryptable, not trashed, owner", () => {
		it("returns only trash button", () => {
			const note = makeNote({ undecryptable: true, trash: false })
			const buttons = createMenuButtons({ note, writeAccess: false, origin: "notes", isOwner: true })
			const ids = buttons.map(b => b.id)

			expect(ids).toEqual(["trash"])
		})
	})

	describe("undecryptable, not trashed, not owner", () => {
		it("returns only leave button", () => {
			const note = makeNote({ undecryptable: true, trash: false })
			const buttons = createMenuButtons({ note, writeAccess: false, origin: "notes", isOwner: false })
			const ids = buttons.map(b => b.id)

			expect(ids).toEqual(["leave"])
		})
	})

	describe("origin='notes' select/deselect", () => {
		it("select button is first in the list for origin='notes'", () => {
			const note = makeNote()
			const buttons = createMenuButtons({ note, writeAccess: true, origin: "notes", isOwner: true })

			expect(buttons[0]?.id).toBe("select")
		})

		it("deselect button is first when note is already selected", () => {
			const note = makeNote()
			const buttons = createMenuButtons({ note, isSelected: true, writeAccess: true, origin: "notes", isOwner: true })

			expect(buttons[0]?.id).toBe("deselect")
		})
	})

	describe("origin='content'", () => {
		it("no select/deselect button present", () => {
			const note = makeNote()
			const buttons = createMenuButtons({ note, writeAccess: true, origin: "content", isOwner: true })
			const ids = buttons.map(b => b.id)

			expect(ids).not.toContain("select")
			expect(ids).not.toContain("deselect")
		})
	})

	describe("origin='search' select/deselect", () => {
		it("select button is first in the list for origin='search'", () => {
			const note = makeNote()
			const buttons = createMenuButtons({ note, writeAccess: true, origin: "search", isOwner: true })

			expect(buttons[0]?.id).toBe("select")
		})

		it("deselect button is first when note is already selected with origin='search'", () => {
			const note = makeNote()
			const buttons = createMenuButtons({ note, isSelected: true, writeAccess: true, origin: "search", isOwner: true })

			expect(buttons[0]?.id).toBe("deselect")
		})
	})

	describe("writeAccess=false", () => {
		it("type, rename, and history buttons are absent", () => {
			const note = makeNote()
			const buttons = createMenuButtons({ note, writeAccess: false, origin: "notes", isOwner: true })
			const ids = buttons.map(b => b.id)

			expect(ids).not.toContain("type")
			expect(ids).not.toContain("rename")
			expect(ids).not.toContain("history")
		})
	})

	describe("writeAccess=true", () => {
		it("type, rename, and history buttons are all present", () => {
			const note = makeNote()
			const buttons = createMenuButtons({ note, writeAccess: true, origin: "notes", isOwner: true })
			const ids = buttons.map(b => b.id)

			expect(ids).toContain("type")
			expect(ids).toContain("rename")
			expect(ids).toContain("history")
		})
	})

	describe("isOwner=true, active note (not archive, not trash)", () => {
		it("archive and trash present, restore absent", () => {
			const note = makeNote({ archive: false, trash: false })
			const buttons = createMenuButtons({ note, writeAccess: true, origin: "notes", isOwner: true })
			const ids = buttons.map(b => b.id)

			expect(ids).toContain("archive")
			expect(ids).toContain("trash")
			expect(ids).not.toContain("restore")
		})
	})

	describe("isOwner=true, archived note", () => {
		it("restore present, archive absent", () => {
			const note = makeNote({ archive: true, trash: false })
			const buttons = createMenuButtons({ note, writeAccess: true, origin: "notes", isOwner: true })
			const ids = buttons.map(b => b.id)

			expect(ids).toContain("restore")
			expect(ids).not.toContain("archive")
		})
	})

	describe("isOwner=true, trashed note", () => {
		it("restore and delete present, trash absent", () => {
			const note = makeNote({ archive: false, trash: true })
			const buttons = createMenuButtons({ note, writeAccess: true, origin: "notes", isOwner: true })
			const ids = buttons.map(b => b.id)

			expect(ids).toContain("restore")
			expect(ids).toContain("delete")
			expect(ids).not.toContain("trash")
		})
	})

	describe("isOwner=false (shared participant)", () => {
		it("leave button present, no archive/trash/delete buttons", () => {
			const note = makeNote()
			const buttons = createMenuButtons({ note, writeAccess: false, origin: "notes", isOwner: false })
			const ids = buttons.map(b => b.id)

			expect(ids).toContain("leave")
			expect(ids).not.toContain("archive")
			expect(ids).not.toContain("trash")
			expect(ids).not.toContain("delete")
		})
	})

	describe("copy_content", () => {
		it("is present for every note type, including richtext", () => {
			for (const noteType of [NoteType.Text, NoteType.Md, NoteType.Code, NoteType.Rich, NoteType.Checklist]) {
				const note = makeNote({ noteType })
				const buttons = createMenuButtons({ note, writeAccess: true, origin: "notes", isOwner: true })
				const ids = buttons.map(b => b.id)

				expect(ids, `copy_content should be present for noteType ${String(noteType)}`).toContain("copy_content")
			}
		})

		it("requires online", () => {
			const note = makeNote()
			const buttons = createMenuButtons({ note, writeAccess: true, origin: "notes", isOwner: true })
			const copyButton = buttons.find(b => b.id === "copy_content")

			expect(copyButton?.requiresOnline).toBe(true)
		})
	})
})

describe("NOTE_TYPE_OPTIONS", () => {
	it("covers all 5 NoteType variants", () => {
		expect(NOTE_TYPE_OPTIONS).toHaveLength(5)

		const types = NOTE_TYPE_OPTIONS.map(o => o.type)

		expect(types).toContain(NoteType.Text)
		expect(types).toContain(NoteType.Md)
		expect(types).toContain(NoteType.Code)
		expect(types).toContain(NoteType.Rich)
		expect(types).toContain(NoteType.Checklist)
	})

	it("all 5 typeString values are distinct", () => {
		const typeStrings = NOTE_TYPE_OPTIONS.map(o => o.typeString)
		const unique = new Set(typeStrings)

		expect(unique.size).toBe(5)
	})
})

describe("NOTE_TYPE_LABEL_KEY", () => {
	it("maps every NoteTypeString to a distinct i18n key", () => {
		const keys = Object.values(NOTE_TYPE_LABEL_KEY)
		const unique = new Set(keys)

		expect(unique.size).toBe(keys.length)
	})

	it("each NoteTypeString maps to its exact i18n key", () => {
		expect(NOTE_TYPE_LABEL_KEY["text"]).toBe("note_type_text")
		expect(NOTE_TYPE_LABEL_KEY["md"]).toBe("note_type_markdown")
		expect(NOTE_TYPE_LABEL_KEY["code"]).toBe("note_type_code")
		expect(NOTE_TYPE_LABEL_KEY["rich"]).toBe("note_type_richtext")
		expect(NOTE_TYPE_LABEL_KEY["checklist"]).toBe("note_type_checklist")
	})
})
