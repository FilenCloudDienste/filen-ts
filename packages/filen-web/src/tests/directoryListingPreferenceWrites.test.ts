// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, type ReactElement, type ReactNode } from "react"
import { act, cleanup, render } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"

// The listing's sort, view-mode and hidden-items controls each write a kv preference and then refetch it.
// A failed write must be logged and toasted, must not refetch and must not escape as an unhandled
// rejection (every control discards the promise). This file renders the listing with its data sources
// stubbed and those controls reduced to probes that hand back their onChange.

const { toastError, setSortPreferences, setViewModePreferences, setHideHiddenItems, refetches, controls } = vi.hoisted(() => ({
	toastError: vi.fn(),
	setSortPreferences: vi.fn<() => Promise<void>>(),
	setViewModePreferences: vi.fn<() => Promise<void>>(),
	setHideHiddenItems: vi.fn<() => Promise<void>>(),
	refetches: { sort: vi.fn(), viewMode: vi.fn(), hidden: vi.fn() },
	controls: {
		sort: undefined as ((next: string | null) => void) | undefined,
		viewMode: undefined as ((next: string) => void) | undefined,
		hidden: undefined as ((next: boolean) => void) | undefined
	}
}))

vi.mock("@/features/drive/lib/preferences", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/lib/preferences")>()),
	setSortPreferences,
	setViewModePreferences,
	setHideHiddenItems
}))
vi.mock("@/features/shell/lib/windowBarSlot", () => ({ useWindowBarSlot: () => document.body }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: toastError, warning: vi.fn() } }))
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }))
vi.mock("@/features/contacts/hooks/useBlockedUsers", async () => {
	const { EMPTY_BLOCKED_USERS } = await vi.importActual<typeof import("@filen/shared")>("@filen/shared")

	return { useBlockedUsers: () => EMPTY_BLOCKED_USERS }
})
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))
vi.mock("@/features/drive/hooks/useDriveSearch", () => ({
	useDriveSearch: () => ({
		input: "",
		setInput: vi.fn(),
		active: false,
		results: [],
		parentPaths: new Map<string, string>(),
		total: 0n,
		status: "idle",
		clear: vi.fn()
	})
}))
vi.mock("@/lib/keymap/useAction", () => ({ useAction: () => () => undefined, OUTSIDE_OVERLAYS: {} }))
vi.mock("@/features/audio/lib/audioEngine", () => ({ audioEngine: { enqueueAndPlay: vi.fn() } }))
vi.mock("@/features/drive/hooks/useDriveDirectorySizes", () => ({ useDriveDirectorySizes: vi.fn() }))
vi.mock("@/features/drive/hooks/useMarqueeSelection", () => ({
	useMarqueeSelection: () => ({ rectStore: { get: () => null, subscribe: () => () => undefined }, onPointerDown: vi.fn() })
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
vi.mock("@/features/drive/hooks/useDriveVirtualizer", () => ({
	useDriveVirtualizer: () => {
		const virtualizer = { scrollToIndex: vi.fn(), getTotalSize: () => 0, getVirtualItems: () => [] }

		return {
			setScrollElement: vi.fn(),
			scrollElement: null,
			columns: 1,
			listVirtualizer: virtualizer,
			gridVirtualizer: virtualizer,
			activeVirtualizer: virtualizer,
			registerRef: vi.fn(),
			itemRefs: { registerRef: vi.fn(), focusItem: vi.fn() }
		}
	}
}))
vi.mock("@/features/drive/components/breadcrumb", () => ({ Breadcrumb: () => null }))
vi.mock("@/features/drive/components/sortMenu", () => ({
	SortMenu: (props: { onChange: (next: string | null) => void }) => {
		controls.sort = props.onChange

		return null
	}
}))
vi.mock("@/features/drive/components/viewModeToggle", () => ({
	ViewModeToggle: (props: { onChange: (next: string) => void; hiddenItems?: { onChange: (next: boolean) => void } }) => {
		controls.viewMode = props.onChange
		controls.hidden = props.hiddenItems?.onChange

		return null
	}
}))
vi.mock("@/features/drive/components/searchInput", () => ({ SearchInput: () => null }))
vi.mock("@/features/drive/components/emptyTrashButton", () => ({ EmptyTrashButton: () => null }))
vi.mock("@/components/loadingState", () => ({ LoadingState: () => null }))
vi.mock("@/features/drive/components/emptyState", () => ({ EmptyState: () => null }))
vi.mock("@/features/drive/components/newDirectory", () => ({ NewDirectoryDialog: () => null }))
vi.mock("@/features/drive/components/uploadMenu", () => ({
	NewMenu: () => null,
	UploadContextMenu: (props: { render: ReactElement }) => props.render
}))
vi.mock("@/features/drive/components/uploadDropzone", () => ({
	UploadDropzone: (props: { children: ReactNode }) => createElement("div", null, props.children)
}))
vi.mock("@/features/drive/components/driveRow", () => ({ DriveRow: () => null }))
vi.mock("@/features/drive/components/driveTile", () => ({ DriveTile: () => null }))
vi.mock("@/features/drive/components/bulkActionBar", () => ({ BulkActionBar: () => null }))
// The session's drive root, read from the worker in the app.
vi.mock("@/queries/driveRoot", async importOriginal => ({
	...(await importOriginal<typeof import("@/queries/driveRoot")>()),
	useDriveRootUuidQuery: () => ({ data: "root-uuid" })
}))
vi.mock("@/features/drive/queries/drive", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/queries/drive")>()),
	useDirectoryListingQuery: () => ({ data: [], status: "success", isRefetchError: false, error: null, refetch: vi.fn() }),
	useSortPreferencesQuery: () => ({ data: undefined, refetch: refetches.sort }),
	useViewModePreferencesQuery: () => ({ data: undefined, refetch: refetches.viewMode }),
	useHideHiddenItemsPreferenceQuery: () => ({ data: false, refetch: refetches.hidden }),
	useHiddenDotFilenRoot: () => null
}))

import { i18n } from "@/lib/i18n"
import { log } from "@/lib/log"
import { DirectoryListing } from "@/features/drive/components/directoryListing"

const CONTROLS = [
	{ name: "sort", write: setSortPreferences, refetch: refetches.sort, change: () => controls.sort?.("name:asc") },
	{ name: "view mode", write: setViewModePreferences, refetch: refetches.viewMode, change: () => controls.viewMode?.("grid") },
	{ name: "hidden items", write: setHideHiddenItems, refetch: refetches.hidden, change: () => controls.hidden?.(true) }
] as const

const unhandled: unknown[] = []

function onUnhandled(reason: unknown): void {
	unhandled.push(reason)
}

// Lets the discarded promise chain (write, catch, toast, refetch) run to its end.
async function settle(): Promise<void> {
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, 0))
	})
}

beforeEach(() => {
	vi.clearAllMocks()
	unhandled.length = 0
	process.on("unhandledRejection", onUnhandled)
	render(createElement(DirectoryListing, { variant: "drive", splat: "" }))
})

afterEach(() => {
	process.off("unhandledRejection", onUnhandled)
	cleanup()
})

describe("DirectoryListing — preference writes", () => {
	for (const control of CONTROLS) {
		it(`a failed ${control.name} write logs, shows the save-failed toast and does not refetch`, async () => {
			const warn = vi.spyOn(log, "warn")

			control.write.mockRejectedValue(new Error("storage worker gone"))

			act(() => {
				control.change()
			})
			await settle()

			expect(control.write).toHaveBeenCalledOnce()
			expect(warn).toHaveBeenCalledWith("settings", "setting write failed", "storage worker gone")
			expect(toastError).toHaveBeenCalledWith(i18n.t("settings:settingsDocumentsSaveFailed"))
			expect(control.refetch).not.toHaveBeenCalled()
			expect(unhandled).toEqual([])
		})

		it(`a stored ${control.name} write refetches the preference`, async () => {
			control.write.mockResolvedValue(undefined)

			act(() => {
				control.change()
			})
			await settle()

			expect(control.refetch).toHaveBeenCalledOnce()
			expect(toastError).not.toHaveBeenCalled()
		})
	}
})
