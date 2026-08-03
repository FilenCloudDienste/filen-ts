// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, type ReactNode } from "react"
import { act, cleanup, render, screen } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"
import type { Dir, File, SharedFile, SharedRootDir, SharingRole, UuidStr } from "@filen/sdk-rs"

// Every ingredient below is exhaustively tested as a function (directoryListing.test.ts, hiddenItems.test.ts,
// preferences.test.ts). What is NOT tested anywhere is that the listing COMBINES them correctly: which
// variant gets the blocked filter, which gets the hide filter, when writing is disabled, and which
// selection purges actually run. Those decisions live only in the component, so this file renders it with
// its data sources stubbed and its presentational children reduced to prop probes.

const { navigate, useBlockedUsers, useIsOnline, searchState } = vi.hoisted(() => ({
	navigate: vi.fn(),
	useBlockedUsers: vi.fn(),
	useIsOnline: vi.fn(() => true),
	searchState: {
		current: {
			input: "",
			setInput: vi.fn(),
			active: false,
			results: [] as unknown[],
			parentPaths: new Map<string, string>(),
			total: 0n,
			status: "idle",
			clear: vi.fn()
		}
	}
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }))
vi.mock("@/features/contacts/hooks/useBlockedUsers", () => ({ useBlockedUsers }))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline }))
vi.mock("@/features/drive/hooks/useDriveSearch", () => ({ useDriveSearch: () => searchState.current }))
// Document-level keymap registration needs the app's hotkeys provider; the listing's shortcut bodies are
// not this file's subject.
vi.mock("@/lib/keymap/useAction", () => ({ useAction: vi.fn() }))
vi.mock("@/features/audio/lib/audioEngine", () => ({ audioEngine: { enqueueAndPlay: vi.fn() } }))
vi.mock("@/features/drive/hooks/useDriveDirectorySizes", () => ({ useDriveDirectorySizes: () => undefined }))
vi.mock("@/features/drive/hooks/useMarqueeSelection", () => ({
	useMarqueeSelection: () => ({ rect: null, onPointerDown: vi.fn() })
}))
vi.mock("@/features/drive/hooks/useDriveDialogHost", () => ({
	useDriveDialogHost: () => ({
		isDialogOpen: false,
		handleItemAction: vi.fn(),
		handleBulkDialogAction: vi.fn(),
		handleEmptyTrash: vi.fn(),
		openPreview: vi.fn(),
		renderActiveDialog: () => null
	})
}))

// jsdom measures every element at 0px, so the real virtualizer would render no rows at all. This stub
// keeps the mapping the component actually decides — WHICH items reach the listbox — observable.
vi.mock("@/features/drive/hooks/useDriveVirtualizer", () => ({
	useDriveVirtualizer: (items: { data: { uuid: string } }[]) => {
		const virtualizer = {
			scrollToIndex: vi.fn(),
			getTotalSize: () => items.length * 40,
			getVirtualItems: () => items.map((_, index) => ({ index, key: index, start: index * 40 }))
		}

		return {
			setScrollElement: vi.fn(),
			scrollElement: null,
			columns: 1,
			listVirtualizer: virtualizer,
			gridVirtualizer: virtualizer,
			activeVirtualizer: virtualizer,
			registerRef: vi.fn(),
			itemRefs: { current: new Map() }
		}
	}
}))

// Presentational children reduced to probes: each renders only what the listing DECIDED for it.
vi.mock("@/features/drive/components/breadcrumb", () => ({ Breadcrumb: () => null }))
vi.mock("@/features/drive/components/sortMenu", () => ({ SortMenu: () => null }))
vi.mock("@/features/drive/components/viewModeToggle", () => ({ ViewModeToggle: () => null }))
vi.mock("@/features/drive/components/searchInput", () => ({ SearchInput: () => null }))
vi.mock("@/features/drive/components/emptyTrashButton", () => ({ EmptyTrashButton: () => null }))
vi.mock("@/features/drive/components/listingSkeleton", () => ({ ListingSkeleton: () => null }))
vi.mock("@/features/drive/components/emptyState", () => ({ EmptyState: () => null }))
vi.mock("@/features/drive/components/newDirectory", () => ({
	NewDirectory: (props: { disabled?: boolean }) =>
		createElement("div", { "data-testid": "new-directory", "data-disabled": String(props.disabled === true) })
}))
vi.mock("@/features/drive/components/uploadMenu", () => ({
	UploadMenu: (props: { disabled?: boolean }) =>
		createElement("div", { "data-testid": "upload-menu", "data-disabled": String(props.disabled === true) })
}))
vi.mock("@/features/drive/components/uploadDropzone", () => ({
	UploadDropzone: (props: { disabled?: boolean; children: ReactNode }) =>
		createElement("div", { "data-testid": "upload-dropzone", "data-disabled": String(props.disabled === true) }, props.children)
}))
vi.mock("@/features/drive/components/driveRow", () => ({
	DriveRow: (props: { item: { data: { uuid: string; decryptedMeta?: { name?: string } | null } } }) =>
		createElement("div", { "data-testid": "row", "data-uuid": props.item.data.uuid }, props.item.data.decryptedMeta?.name ?? "")
}))
vi.mock("@/features/drive/components/driveTile", () => ({ DriveTile: () => null }))
vi.mock("@/features/drive/components/bulkActionBar", () => ({
	BulkActionBar: (props: { selectedItems: { data: { uuid: string; decryptedMeta?: { name?: string } | null } }[] }) =>
		createElement(
			"div",
			{ "data-testid": "bulk-bar" },
			props.selectedItems.map(item => item.data.decryptedMeta?.name ?? item.data.uuid).join("|")
		)
}))

const { listingQuery, hiddenPref } = vi.hoisted(() => ({
	listingQuery: { current: { data: [] as unknown[], status: "success", isRefetchError: false, error: null } },
	hiddenPref: { current: false }
}))

vi.mock("@/features/drive/queries/drive", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/queries/drive")>()),
	useDirectoryListingQuery: () => ({ ...listingQuery.current, refetch: vi.fn() }),
	useSortPreferencesQuery: () => ({ data: undefined, refetch: vi.fn() }),
	useViewModePreferencesQuery: () => ({ data: undefined, refetch: vi.fn() }),
	useHideHiddenItemsPreferenceQuery: () => ({ data: hiddenPref.current, refetch: vi.fn() })
}))

import "@/lib/i18n"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { deriveBlockedUsers, EMPTY_BLOCKED_USERS } from "@/features/contacts/lib/blocking"
import { useDriveStore } from "@/features/drive/store/useDriveStore"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { DirectoryListing } from "@/features/drive/components/directoryListing"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function sharerRole(id: number, email: string): SharingRole {
	return { Sharer: { email, id } }
}

function mockDir(name: string, uuid = testUuid(name)): Dir {
	return {
		uuid,
		parent: testUuid("parent"),
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "decoded", data: { name } }
	}
}

function mockFile(name: string, uuid = testUuid(name)): File {
	return {
		uuid,
		parent: testUuid("parent"),
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: {
			type: "decoded",
			data: { name, mime: "application/pdf", modified: 1_700_000_000_000n, size: 1_024n, key: "key", version: 2 }
		}
	}
}

function mockSharedRootDir(name: string, role: SharingRole): SharedRootDir {
	return {
		inner: { uuid: testUuid(name), color: "default", timestamp: 1_700_000_000_000n, meta: { type: "decoded", data: { name } } },
		sharingRole: role,
		writeAccess: true
	}
}

function mockSharedFile(name: string, role: SharingRole): SharedFile {
	return {
		uuid: testUuid(name),
		size: 2_048n,
		region: "de-1",
		bucket: "filen-1",
		chunks: 2n,
		timestamp: 1_700_000_000_000n,
		meta: {
			type: "decoded",
			data: { name, mime: "application/pdf", modified: 1_700_000_000_000n, size: 2_048n, key: "k", version: 2 }
		},
		sharingRole: role,
		sharedTag: true
	}
}

const BLOCKED_ROLE = sharerRole(10, "blocked@x.com")
const OK_ROLE = sharerRole(20, "ok@x.com")
const blockedUsers = deriveBlockedUsers([
	{ uuid: testUuid("blocked-contact"), userId: 10n, email: "blocked@x.com", nickName: "Blocked", timestamp: 1n }
])

function renderListing(options: { variant?: DriveVariant; splat?: string; items?: DriveItem[] } = {}) {
	const variant = options.variant ?? "drive"
	const splat = options.splat ?? ""

	listingQuery.current = { ...listingQuery.current, data: options.items ?? [] }

	const rendered = render(createElement(DirectoryListing, { variant, splat }))

	return {
		...rendered,
		// The listing's own [variant, splat] navigation reset clears the selection on mount, so a
		// selection under test is made AFTER it — exactly as a user click would.
		select: (items: DriveItem[]) => {
			act(() => {
				useDriveStore.setState({ selectedItems: items })
			})
		},
		// Re-renders in place after a mocked data source changed (the blocked set landing, the hide
		// preference flipping, a search push) — the effect deps those feed are what the purges key on.
		refresh: () => {
			rendered.rerender(createElement(DirectoryListing, { variant, splat }))
		}
	}
}

function renderedNames(): string[] {
	return screen.queryAllByTestId("row").map(row => row.textContent)
}

function writeSurfaceStates(): Record<string, string> {
	return {
		newDirectory: screen.getByTestId("new-directory").getAttribute("data-disabled") ?? "",
		uploadMenu: screen.getByTestId("upload-menu").getAttribute("data-disabled") ?? "",
		dropzone: screen.getByTestId("upload-dropzone").getAttribute("data-disabled") ?? ""
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	useIsOnline.mockReturnValue(true)
	useBlockedUsers.mockReturnValue(EMPTY_BLOCKED_USERS)
	listingQuery.current = { data: [], status: "success", isRefetchError: false, error: null }
	hiddenPref.current = false
	searchState.current = { ...searchState.current, active: false, results: [], total: 0n, status: "idle" }
	useDriveStore.setState({ selectedItems: [], pendingReveal: null })
})

afterEach(cleanup)

// One gate feeds New directory, Upload and the drop target — a listing with no confirmed write target
// (or no connection) must offer none of the three.
describe("DirectoryListing — write gate", () => {
	it("enables all three write surfaces in an online, loaded drive listing", () => {
		renderListing({ items: [narrowItem(mockDir("Documents"))] })

		expect(writeSurfaceStates()).toEqual({ newDirectory: "false", uploadMenu: "false", dropzone: "false" })
	})

	it("disables them while offline — every one of them writes through the SDK", () => {
		useIsOnline.mockReturnValue(false)
		renderListing({ items: [narrowItem(mockDir("Documents"))] })

		expect(writeSurfaceStates()).toEqual({ newDirectory: "true", uploadMenu: "true", dropzone: "true" })
	})

	it("disables them while the listing is still loading — there is no confirmed target uuid yet", () => {
		listingQuery.current = { data: [], status: "pending", isRefetchError: false, error: null }
		renderListing()

		expect(writeSurfaceStates()).toEqual({ newDirectory: "true", uploadMenu: "true", dropzone: "true" })
	})

	it("disables them on the sharedOut ROOT but enables them inside an owned nested sharedOut directory", () => {
		renderListing({ variant: "sharedOut", splat: "" })

		expect(writeSurfaceStates()).toEqual({ newDirectory: "true", uploadMenu: "true", dropzone: "true" })

		cleanup()
		renderListing({ variant: "sharedOut", splat: testUuid("nested") })

		expect(writeSurfaceStates()).toEqual({ newDirectory: "false", uploadMenu: "false", dropzone: "false" })
	})

	it("disables them on every variant that has no directory to write into", () => {
		for (const variant of ["trash", "favorites", "recents", "links", "sharedIn"] as const) {
			renderListing({ variant })

			expect(writeSurfaceStates()).toEqual({ newDirectory: "true", uploadMenu: "true", dropzone: "true" })

			cleanup()
		}
	})
})

// The live free-tier e2e account has no blocked users, so this wiring is unreachable in a browser.
describe("DirectoryListing — blocked-sharer filter (sharedIn only)", () => {
	const items = [narrowItem(mockSharedRootDir("FromBlocked", BLOCKED_ROLE)), narrowItem(mockSharedFile("FromFriend", OK_ROLE))]

	it("hides a blocked sharer's item from sharedIn", () => {
		useBlockedUsers.mockReturnValue(blockedUsers)
		renderListing({ variant: "sharedIn", items })

		expect(renderedNames()).toEqual(["FromFriend"])
	})

	it("leaves every other variant's listing untouched by the same blocked set", () => {
		useBlockedUsers.mockReturnValue(blockedUsers)
		renderListing({ variant: "sharedOut", items })

		expect(renderedNames()).toEqual(["FromBlocked", "FromFriend"])
	})

	// The underlying contacts read is gated on this flag, and a disabled query derives to an EMPTY
	// blocked set — so an accidental `false` here silently unblocks every blocked sharer.
	it("fetches the blocked list for sharedIn and for nothing else", () => {
		renderListing({ variant: "sharedIn" })

		expect(useBlockedUsers).toHaveBeenCalledWith(true)

		cleanup()
		vi.clearAllMocks()
		useBlockedUsers.mockReturnValue(EMPTY_BLOCKED_USERS)

		for (const variant of ["drive", "trash", "favorites", "recents", "links", "sharedOut"] as const) {
			renderListing({ variant })
			cleanup()
		}

		expect(useBlockedUsers.mock.calls.every(call => call[0] === false)).toBe(true)
	})

	// Blocking a contact while their shared item sits in the selection: the bulk bar must not keep a row
	// nobody can see any more in its scope.
	it("purges a selected item whose sharer just became blocked", () => {
		const { select, refresh } = renderListing({ variant: "sharedIn", items })

		select(items)
		useBlockedUsers.mockReturnValue(blockedUsers)
		refresh()

		expect(useDriveStore.getState().selectedItems.map(item => item.data.uuid)).toEqual([items[1]?.data.uuid])
	})
})

// The preference is stored as HIDE and applies only to the two surfaces you browse your own content on.
describe("DirectoryListing — hidden-items filter", () => {
	const items = [narrowItem(mockDir("Documents")), narrowItem(mockFile(".env"))]

	it("applies the hide preference on the drive listing", () => {
		hiddenPref.current = true
		renderListing({ variant: "drive", items })

		expect(renderedNames()).toEqual(["Documents"])
	})

	it("never applies it to a variant it does not own, however the preference is set", () => {
		hiddenPref.current = true
		renderListing({ variant: "trash", items })

		expect(renderedNames()).toEqual(["Documents", ".env"])
	})

	it("purges a selected row the hide filter removed from view", () => {
		const { select, refresh } = renderListing({ variant: "drive", items })

		select(items)
		hiddenPref.current = true
		refresh()

		expect(useDriveStore.getState().selectedItems.map(item => item.data.decryptedMeta?.name)).toEqual(["Documents"])
	})
})

// Search results are PUSH-fed: a live resync can drop a selected hit with no navigation involved, and
// the freshest copy of a still-selected hit lives in the result set, not in the click-time snapshot.
describe("DirectoryListing — search-driven selection reconcile", () => {
	const stale = narrowItem(mockDir("Old name", testUuid("hit")))
	const fresh = narrowItem(mockDir("New name", testUuid("hit")))
	const dropped = narrowItem(mockDir("Dropped"))

	function activateSearch(results: DriveItem[]): void {
		searchState.current = {
			...searchState.current,
			input: "n",
			active: true,
			results,
			total: BigInt(results.length),
			status: "settled"
		}
	}

	it("hands the bulk bar the freshest copy of a still-selected hit, not the click-time snapshot", () => {
		activateSearch([fresh])

		const { select } = renderListing({ variant: "drive" })

		select([stale])

		expect(screen.getByTestId("bulk-bar").textContent).toBe("New name")
	})

	it("drops a selected hit that a push removed from the result set", () => {
		activateSearch([fresh, dropped])

		const { select, refresh } = renderListing({ variant: "drive" })

		select([fresh, dropped])
		activateSearch([fresh])
		refresh()

		expect(useDriveStore.getState().selectedItems.map(item => item.data.uuid)).toEqual([fresh.data.uuid])
	})
})
