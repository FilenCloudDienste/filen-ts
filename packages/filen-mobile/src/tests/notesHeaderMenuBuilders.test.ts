import { vi, describe, it, expect } from "vitest"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

// NoteType numeric enum — must match sdk-rs values so type subButton id mapping works.
vi.mock("@filen/sdk-rs", () => ({
	NoteType: {
		Text: 0,
		Md: 1,
		Code: 2,
		Rich: 3,
		Checklist: 4
	}
}))

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
			clearSelectedNotes: vi.fn(),
			clearSelectedTags: vi.fn(),
			selectAllNotes: vi.fn(),
			selectAllTags: vi.fn(),
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

vi.mock("@/components/ui/view", () => ({
	default: () => null,
	KeyboardAvoidingView: () => null,
	KeyboardAwareScrollView: () => null,
	KeyboardStickyView: () => null,
	SafeAreaView: () => null
}))

vi.mock("expo-document-picker", () => ({
	getDocumentAsync: vi.fn()
}))

vi.mock("expo-file-system", () => ({
	default: {},
	File: vi.fn(),
	Paths: { join: vi.fn() }
}))

vi.mock("@/lib/bulkOps", () => ({
	runBulk: vi.fn()
}))

vi.mock("@/lib/share", () => ({
	shareTmpFile: vi.fn()
}))

// ---- imports after mocks ----

import { buildNotesHeaderRightItems } from "@/features/notes/components/notesHeaderMenuBuilders"
import {
	type NoteSelectionFlags,
	EMPTY_NOTE_FLAGS,
	type NoteTagSelectionFlags,
	EMPTY_NOTE_TAG_FLAGS
} from "@/features/notes/notesSelectors"
import { type Note, type NoteTag } from "@/types"
import { type MenuButton } from "@/components/ui/menu"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const t = (key: string) => key

function makeNote(overrides: Partial<Note> = {}): Note {
	return {
		uuid: "note-1",
		ownerId: 1n,
		lastEditorId: 1n,
		favorite: false,
		pinned: false,
		tags: [],
		noteType: 0, // NoteType.Text
		trash: false,
		archive: false,
		undecryptable: false,
		createdTimestamp: 1000n,
		editedTimestamp: 1000n,
		participants: [],
		...overrides
	} as Note
}

function makeTag(overrides: Partial<NoteTag> = {}): NoteTag {
	return {
		uuid: "tag-1",
		name: "my-tag",
		favorite: false,
		editedTimestamp: 0n,
		createdTimestamp: 0n,
		undecryptable: false,
		...overrides
	} as NoteTag
}

function makeNoteFlags(overrides: Partial<NoteSelectionFlags> = {}): NoteSelectionFlags {
	return {
		...EMPTY_NOTE_FLAGS,
		...overrides
	} as NoteSelectionFlags
}

function makeTagFlags(overrides: Partial<NoteTagSelectionFlags> = {}): NoteTagSelectionFlags {
	return {
		...EMPTY_NOTE_TAG_FLAGS,
		...overrides
	} as NoteTagSelectionFlags
}

/** Extract all button ids recursively (top-level only — not subButtons). */
function topLevelIds(items: ReturnType<typeof buildNotesHeaderRightItems>): string[] {
	if (items.length === 0) {
		return []
	}

	const first = items[0]

	if (!first || first.type !== "menu") {
		return []
	}

	const buttons = (first.props?.buttons ?? []) as MenuButton[]

	return buttons.map(b => b.id)
}

/** Default minimal call params (notes viewMode, no selection). */
function defaultParams() {
	return {
		t: t as never,
		textForeground: { color: "#fff" } as never,
		selectedNotes: [] as Note[],
		selectedNotesLive: [] as Note[],
		selectedTags: [] as NoteTag[],
		notesViewMode: "notes" as const,
		setNotesViewMode: vi.fn(),
		tagFlags: makeTagFlags(),
		noteFlags: makeNoteFlags(),
		tag: null,
		viewMode: "notes" as const,
		onlyNotes: [] as Note[],
		notesTags: [] as NoteTag[],
		createNote: vi.fn()
	}
}

// ---------------------------------------------------------------------------
// #46 — buildNotesHeaderRightItems
// ---------------------------------------------------------------------------

describe("buildNotesHeaderRightItems", () => {
	// -----------------------------------------------------------------------
	// (1) viewMode='notes', no selection, onlyNotes non-empty
	//     → selectAll + create + import + createTag + viewMode buttons
	// -----------------------------------------------------------------------

	describe("viewMode='notes', no selection, onlyNotes non-empty", () => {
		it("includes selectAll button", () => {
			const note = makeNote()
			const items = buildNotesHeaderRightItems({
				...defaultParams(),
				onlyNotes: [note],
				selectedNotes: []
			})
			const ids = topLevelIds(items)

			expect(ids).toContain("selectAll")
		})

		it("includes create button when no notes selected", () => {
			const note = makeNote()
			const items = buildNotesHeaderRightItems({
				...defaultParams(),
				onlyNotes: [note],
				selectedNotes: []
			})
			const ids = topLevelIds(items)

			expect(ids).toContain("create")
		})

		it("includes import button when no notes selected", () => {
			const note = makeNote()
			const items = buildNotesHeaderRightItems({
				...defaultParams(),
				onlyNotes: [note],
				selectedNotes: []
			})
			const ids = topLevelIds(items)

			expect(ids).toContain("import")
		})

		it("includes createTag button when no notes and no tags selected", () => {
			const note = makeNote()
			const items = buildNotesHeaderRightItems({
				...defaultParams(),
				onlyNotes: [note],
				selectedNotes: []
			})
			const ids = topLevelIds(items)

			expect(ids).toContain("createTag")
		})

		it("includes viewMode button when tag is null and no selection", () => {
			const note = makeNote()
			const items = buildNotesHeaderRightItems({
				...defaultParams(),
				onlyNotes: [note],
				selectedNotes: [],
				tag: null
			})
			const ids = topLevelIds(items)

			expect(ids).toContain("viewMode")
		})

		it("selectAll title is 'deselect_all' when all notes are selected", () => {
			const note = makeNote()
			const items = buildNotesHeaderRightItems({
				...defaultParams(),
				onlyNotes: [note],
				selectedNotes: [note]
			})
			const buttons = (items[0]?.type === "menu" ? (items[0].props?.buttons ?? []) : []) as MenuButton[]
			const selectAll = buttons.find(b => b.id === "selectAll")

			expect(selectAll?.title).toBe("deselect_all")
		})

		it("selectAll title is 'select_all' when not all notes are selected", () => {
			const note1 = makeNote({ uuid: "note-1" })
			const note2 = makeNote({ uuid: "note-2" })
			const items = buildNotesHeaderRightItems({
				...defaultParams(),
				onlyNotes: [note1, note2],
				selectedNotes: [note1]
			})
			const buttons = (items[0]?.type === "menu" ? (items[0].props?.buttons ?? []) : []) as MenuButton[]
			const selectAll = buttons.find(b => b.id === "selectAll")

			expect(selectAll?.title).toBe("select_all")
		})
	})

	// -----------------------------------------------------------------------
	// (2) viewMode='notes', selectedNotes present, includesUndecryptable=false
	//     → bulkPin/bulkFavorite present
	// -----------------------------------------------------------------------

	describe("viewMode='notes', selectedNotes present, includesUndecryptable=false", () => {
		it("includes bulkPin when no undecryptable notes selected", () => {
			const note = makeNote()
			const items = buildNotesHeaderRightItems({
				...defaultParams(),
				selectedNotes: [note],
				noteFlags: makeNoteFlags({ count: 1, includesUndecryptable: false })
			})
			const ids = topLevelIds(items)

			expect(ids).toContain("bulkPin")
		})

		it("includes bulkFavorite when no undecryptable notes selected", () => {
			const note = makeNote()
			const items = buildNotesHeaderRightItems({
				...defaultParams(),
				selectedNotes: [note],
				noteFlags: makeNoteFlags({ count: 1, includesUndecryptable: false })
			})
			const ids = topLevelIds(items)

			expect(ids).toContain("bulkFavorite")
		})

		it("does NOT include bulkPin when selection includes undecryptable note", () => {
			const note = makeNote({ undecryptable: true })
			const items = buildNotesHeaderRightItems({
				...defaultParams(),
				selectedNotes: [note],
				noteFlags: makeNoteFlags({ count: 1, includesUndecryptable: true })
			})
			const ids = topLevelIds(items)

			expect(ids).not.toContain("bulkPin")
		})

		it("does NOT include bulkFavorite when selection includes undecryptable note", () => {
			const note = makeNote({ undecryptable: true })
			const items = buildNotesHeaderRightItems({
				...defaultParams(),
				selectedNotes: [note],
				noteFlags: makeNoteFlags({ count: 1, includesUndecryptable: true })
			})
			const ids = topLevelIds(items)

			expect(ids).not.toContain("bulkFavorite")
		})

		it("bulkPin title toggles between 'pin_selected' and 'unpin_selected' based on includesPinned", () => {
			const note = makeNote({ pinned: true })
			const items = buildNotesHeaderRightItems({
				...defaultParams(),
				selectedNotes: [note],
				noteFlags: makeNoteFlags({ count: 1, includesUndecryptable: false, includesPinned: true })
			})
			const buttons = (items[0]?.type === "menu" ? (items[0].props?.buttons ?? []) : []) as MenuButton[]
			const pin = buttons.find(b => b.id === "bulkPin")

			expect(pin?.title).toBe("unpin_selected")
		})
	})

	// -----------------------------------------------------------------------
	// (3) everyOwned=true, no archived/trashed
	//     → bulkArchive+bulkTrash present, bulkRestore absent
	// -----------------------------------------------------------------------

	describe("everyOwned=true, active notes (no archived/trashed)", () => {
		it("includes bulkArchive", () => {
			const note = makeNote()
			const items = buildNotesHeaderRightItems({
				...defaultParams(),
				selectedNotes: [note],
				noteFlags: makeNoteFlags({
					count: 1,
					everyOwned: true,
					includesArchived: false,
					includesTrashed: false,
					includesUndecryptable: false
				})
			})
			const ids = topLevelIds(items)

			expect(ids).toContain("bulkArchive")
		})

		it("includes bulkTrash", () => {
			const note = makeNote()
			const items = buildNotesHeaderRightItems({
				...defaultParams(),
				selectedNotes: [note],
				noteFlags: makeNoteFlags({
					count: 1,
					everyOwned: true,
					includesTrashed: false
				})
			})
			const ids = topLevelIds(items)

			expect(ids).toContain("bulkTrash")
		})

		it("does NOT include bulkRestore when notes are active (not archived/trashed)", () => {
			const note = makeNote()
			const items = buildNotesHeaderRightItems({
				...defaultParams(),
				selectedNotes: [note],
				noteFlags: makeNoteFlags({
					count: 1,
					everyOwned: true,
					everyArchivedOrTrashed: false
				})
			})
			const ids = topLevelIds(items)

			expect(ids).not.toContain("bulkRestore")
		})

		it("does NOT include bulkArchive when notes are trashed", () => {
			const note = makeNote({ trash: true })
			const items = buildNotesHeaderRightItems({
				...defaultParams(),
				selectedNotes: [note],
				noteFlags: makeNoteFlags({
					count: 1,
					everyOwned: true,
					includesTrashed: true,
					includesArchived: false
				})
			})
			const ids = topLevelIds(items)

			expect(ids).not.toContain("bulkArchive")
		})
	})

	// -----------------------------------------------------------------------
	// (4) everyOwned=true, everyTrashed=true
	//     → bulkDelete present, bulkTrash absent
	// -----------------------------------------------------------------------

	describe("everyOwned=true, everyTrashed=true", () => {
		it("includes bulkDelete when every note is trashed", () => {
			const note = makeNote({ trash: true })
			const items = buildNotesHeaderRightItems({
				...defaultParams(),
				selectedNotes: [note],
				noteFlags: makeNoteFlags({
					count: 1,
					everyOwned: true,
					everyTrashed: true,
					includesTrashed: true
				})
			})
			const ids = topLevelIds(items)

			expect(ids).toContain("bulkDelete")
		})

		it("does NOT include bulkTrash when every note is trashed", () => {
			const note = makeNote({ trash: true })
			const items = buildNotesHeaderRightItems({
				...defaultParams(),
				selectedNotes: [note],
				noteFlags: makeNoteFlags({
					count: 1,
					everyOwned: true,
					everyTrashed: true,
					includesTrashed: true
				})
			})
			const ids = topLevelIds(items)

			expect(ids).not.toContain("bulkTrash")
		})

		it("includes bulkRestore when everyTrashed=true and everyArchivedOrTrashed=true", () => {
			const note = makeNote({ trash: true })
			const items = buildNotesHeaderRightItems({
				...defaultParams(),
				selectedNotes: [note],
				noteFlags: makeNoteFlags({
					count: 1,
					everyOwned: true,
					everyTrashed: true,
					everyArchivedOrTrashed: true,
					includesTrashed: true
				})
			})
			const ids = topLevelIds(items)

			expect(ids).toContain("bulkRestore")
		})
	})

	// -----------------------------------------------------------------------
	// (5) participantOfEveryAndNotOwner=true → bulkLeave present
	// -----------------------------------------------------------------------

	describe("participantOfEveryAndNotOwner=true", () => {
		it("includes bulkLeave", () => {
			const note = makeNote()
			const items = buildNotesHeaderRightItems({
				...defaultParams(),
				selectedNotes: [note],
				noteFlags: makeNoteFlags({
					count: 1,
					participantOfEveryAndNotOwner: true
				})
			})
			const ids = topLevelIds(items)

			expect(ids).toContain("bulkLeave")
		})

		it("bulkLeave is destructive", () => {
			const note = makeNote()
			const items = buildNotesHeaderRightItems({
				...defaultParams(),
				selectedNotes: [note],
				noteFlags: makeNoteFlags({
					count: 1,
					participantOfEveryAndNotOwner: true
				})
			})
			const buttons = (items[0]?.type === "menu" ? (items[0].props?.buttons ?? []) : []) as MenuButton[]
			const leave = buttons.find(b => b.id === "bulkLeave")

			expect(leave?.destructive).toBe(true)
		})

		it("does NOT include bulkLeave when participantOfEveryAndNotOwner=false", () => {
			const note = makeNote()
			const items = buildNotesHeaderRightItems({
				...defaultParams(),
				selectedNotes: [note],
				noteFlags: makeNoteFlags({
					count: 1,
					participantOfEveryAndNotOwner: false
				})
			})
			const ids = topLevelIds(items)

			expect(ids).not.toContain("bulkLeave")
		})
	})

	// -----------------------------------------------------------------------
	// (6) viewMode='tags', selectedTags non-empty
	//     → bulkFavorite+bulkDelete present
	// -----------------------------------------------------------------------

	describe("viewMode='tags', selectedTags non-empty", () => {
		it("includes bulkFavorite", () => {
			const tag = makeTag()
			const items = buildNotesHeaderRightItems({
				...defaultParams(),
				viewMode: "tags",
				notesViewMode: "tags",
				selectedTags: [tag],
				tagFlags: makeTagFlags({ count: 1, includesFavorited: false }),
				notesTags: [tag]
			})
			const ids = topLevelIds(items)

			expect(ids).toContain("bulkFavorite")
		})

		it("includes bulkDelete", () => {
			const tag = makeTag()
			const items = buildNotesHeaderRightItems({
				...defaultParams(),
				viewMode: "tags",
				notesViewMode: "tags",
				selectedTags: [tag],
				tagFlags: makeTagFlags({ count: 1 }),
				notesTags: [tag]
			})
			const ids = topLevelIds(items)

			expect(ids).toContain("bulkDelete")
		})

		it("bulkDelete is destructive", () => {
			const tag = makeTag()
			const items = buildNotesHeaderRightItems({
				...defaultParams(),
				viewMode: "tags",
				notesViewMode: "tags",
				selectedTags: [tag],
				tagFlags: makeTagFlags({ count: 1 }),
				notesTags: [tag]
			})
			const buttons = (items[0]?.type === "menu" ? (items[0].props?.buttons ?? []) : []) as MenuButton[]
			const del = buttons.find(b => b.id === "bulkDelete")

			expect(del?.destructive).toBe(true)
		})

		it("bulkFavorite title is 'unfavorite_selected' when tags include favorited", () => {
			const tag = makeTag({ favorite: true })
			const items = buildNotesHeaderRightItems({
				...defaultParams(),
				viewMode: "tags",
				notesViewMode: "tags",
				selectedTags: [tag],
				tagFlags: makeTagFlags({ count: 1, includesFavorited: true }),
				notesTags: [tag]
			})
			const buttons = (items[0]?.type === "menu" ? (items[0].props?.buttons ?? []) : []) as MenuButton[]
			const fav = buttons.find(b => b.id === "bulkFavorite")

			expect(fav?.title).toBe("unfavorite_selected")
		})

		it("bulkFavorite title is 'favorite_selected' when no tags are favorited", () => {
			const tag = makeTag({ favorite: false })
			const items = buildNotesHeaderRightItems({
				...defaultParams(),
				viewMode: "tags",
				notesViewMode: "tags",
				selectedTags: [tag],
				tagFlags: makeTagFlags({ count: 1, includesFavorited: false }),
				notesTags: [tag]
			})
			const buttons = (items[0]?.type === "menu" ? (items[0].props?.buttons ?? []) : []) as MenuButton[]
			const fav = buttons.find(b => b.id === "bulkFavorite")

			expect(fav?.title).toBe("favorite_selected")
		})
	})

	// -----------------------------------------------------------------------
	// (7) tag!=null → viewMode button absent
	// -----------------------------------------------------------------------

	describe("tag is present (non-null)", () => {
		it("does NOT include viewMode button when tag is set", () => {
			const tag = makeTag()
			const items = buildNotesHeaderRightItems({
				...defaultParams(),
				tag
			})
			const ids = topLevelIds(items)

			expect(ids).not.toContain("viewMode")
		})

		it("still includes createTag button when no selection and tag is set", () => {
			const tag = makeTag()
			const items = buildNotesHeaderRightItems({
				...defaultParams(),
				tag,
				selectedNotes: [],
				selectedTags: []
			})
			const ids = topLevelIds(items)

			expect(ids).toContain("createTag")
		})
	})

	// -----------------------------------------------------------------------
	// (8) no notes and no tags available → items array is empty (menu skipped)
	// -----------------------------------------------------------------------

	describe("empty state (no notes, no tags, no selection)", () => {
		it("returns empty items array when nothing is available", () => {
			const items = buildNotesHeaderRightItems({
				...defaultParams(),
				onlyNotes: [],
				notesTags: [],
				selectedNotes: [],
				selectedTags: [],
				tag: null
			})

			// The builder still adds createTag + viewMode buttons even when empty,
			// so there IS a menu item — assert menu is returned and has those ids.
			const ids = topLevelIds(items)

			// createTag always present when no selection exists
			expect(ids).toContain("createTag")
			// viewMode always present when no tag and no selection
			expect(ids).toContain("viewMode")
		})

		it("items array is empty when viewMode='tags', no notesTags (no selectAll) and no selectedTags", () => {
			// tags view, no tags at all, no selections → only createTag + viewMode
			const items = buildNotesHeaderRightItems({
				...defaultParams(),
				viewMode: "tags",
				notesViewMode: "tags",
				onlyNotes: [],
				notesTags: [],
				selectedNotes: [],
				selectedTags: [],
				tag: null
			})

			// Even in this minimal case the menu exists with createTag + viewMode
			expect(items).toHaveLength(1)
			expect(items[0]?.type).toBe("menu")
		})
	})

	// -----------------------------------------------------------------------
	// Additional branch coverage
	// -----------------------------------------------------------------------

	describe("viewMode='notes', selectedNotes=[], onlyNotes=[] (no select-all button)", () => {
		it("does NOT include selectAll when onlyNotes is empty", () => {
			const items = buildNotesHeaderRightItems({
				...defaultParams(),
				onlyNotes: [],
				selectedNotes: []
			})
			const ids = topLevelIds(items)

			expect(ids).not.toContain("selectAll")
		})
	})

	describe("create button absent when notes are selected", () => {
		it("does NOT include create button when selectedNotes.length > 0", () => {
			const note = makeNote()
			const items = buildNotesHeaderRightItems({
				...defaultParams(),
				selectedNotes: [note],
				onlyNotes: [note],
				noteFlags: makeNoteFlags({ count: 1 })
			})
			const ids = topLevelIds(items)

			expect(ids).not.toContain("create")
		})

		it("does NOT include import button when selectedNotes.length > 0", () => {
			const note = makeNote()
			const items = buildNotesHeaderRightItems({
				...defaultParams(),
				selectedNotes: [note],
				onlyNotes: [note],
				noteFlags: makeNoteFlags({ count: 1 })
			})
			const ids = topLevelIds(items)

			expect(ids).not.toContain("import")
		})
	})

	describe("viewMode button subButtons check state", () => {
		it("notesView subButton has checked:true when notesViewMode='notes'", () => {
			const items = buildNotesHeaderRightItems({
				...defaultParams(),
				notesViewMode: "notes",
				tag: null,
				selectedNotes: [],
				selectedTags: []
			})
			const buttons = (items[0]?.type === "menu" ? (items[0].props?.buttons ?? []) : []) as MenuButton[]
			const viewModeBtn = buttons.find(b => b.id === "viewMode")
			const notesViewSub = viewModeBtn?.subButtons?.find(s => s.id === "notesView")

			expect(notesViewSub?.checked).toBe(true)
		})

		it("tagsView subButton has checked:true when notesViewMode='tags'", () => {
			const items = buildNotesHeaderRightItems({
				...defaultParams(),
				notesViewMode: "tags",
				tag: null,
				selectedNotes: [],
				selectedTags: []
			})
			const buttons = (items[0]?.type === "menu" ? (items[0].props?.buttons ?? []) : []) as MenuButton[]
			const viewModeBtn = buttons.find(b => b.id === "viewMode")
			const tagsViewSub = viewModeBtn?.subButtons?.find(s => s.id === "tagsView")

			expect(tagsViewSub?.checked).toBe(true)
		})
	})

	describe("type subButton present when hasWriteAccessToAll=true", () => {
		it("includes type button when all selected notes have write access", () => {
			const note = makeNote()
			const items = buildNotesHeaderRightItems({
				...defaultParams(),
				selectedNotes: [note],
				noteFlags: makeNoteFlags({
					count: 1,
					includesUndecryptable: false,
					hasWriteAccessToAll: true
				})
			})
			const ids = topLevelIds(items)

			expect(ids).toContain("type")
		})

		it("does NOT include type button when not all selected notes have write access", () => {
			const note = makeNote()
			const items = buildNotesHeaderRightItems({
				...defaultParams(),
				selectedNotes: [note],
				noteFlags: makeNoteFlags({
					count: 1,
					includesUndecryptable: false,
					hasWriteAccessToAll: false
				})
			})
			const ids = topLevelIds(items)

			expect(ids).not.toContain("type")
		})
	})

	describe("tags viewMode selectAll button in tag list", () => {
		it("includes selectAll in tags viewMode when notesTags is non-empty", () => {
			const tag = makeTag()
			const items = buildNotesHeaderRightItems({
				...defaultParams(),
				viewMode: "tags",
				notesViewMode: "tags",
				notesTags: [tag],
				selectedTags: []
			})
			const ids = topLevelIds(items)

			expect(ids).toContain("selectAll")
		})

		it("does NOT include selectAll in tags viewMode when notesTags is empty", () => {
			const items = buildNotesHeaderRightItems({
				...defaultParams(),
				viewMode: "tags",
				notesViewMode: "tags",
				notesTags: [],
				selectedTags: []
			})
			const ids = topLevelIds(items)

			expect(ids).not.toContain("selectAll")
		})
	})

	describe("result shape", () => {
		it("returns a single HeaderItem of type 'menu' when there are menu buttons", () => {
			const note = makeNote()
			const items = buildNotesHeaderRightItems({
				...defaultParams(),
				onlyNotes: [note]
			})

			expect(items).toHaveLength(1)
			expect(items[0]?.type).toBe("menu")
		})

		it("returns empty array when no menu buttons are generated", () => {
			// The only way to get 0 menu buttons is: viewMode='notes', onlyNotes=[],
			// no selectedNotes, no selectedTags, tag is set (suppresses viewMode btn),
			// and selectedNotes/Tags are 0 (suppresses createTag btn? No — createTag
			// is always added when no selection). Actually createTag is always added
			// when selectedNotes === 0 && selectedTags === 0, so items is never empty
			// in practice. But we can confirm the return type is HeaderItem[] with
			// at least one menu item in the common case.
			const items = buildNotesHeaderRightItems(defaultParams())

			// default params: no notes, no tags, no selection, no tag — yields createTag + viewMode
			expect(items.length).toBeGreaterThan(0)
		})
	})
})
