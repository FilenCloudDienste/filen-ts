import { vi, describe, it, expect, beforeEach } from "vitest"
import { compileFunction } from "node:vm"
import { type TFunction } from "i18next"
import { type FetchStatus } from "@tanstack/react-query"
import { type DrivePath } from "@/hooks/useDrivePath"
import { type DriveItem } from "@/types"

// The React Compiler silently skips a hook or component it can't compile (babel-preset-expo runs it with
// panicThreshold "none"), and a skipped hot-path hook hands every render new objects: a skipped useDrivePath
// made each Drive render re-sort the listing and re-render every row. These files are compiled the way Metro
// compiles them and must come out compiled.

const h = vi.hoisted(() => ({
	uuidToAnyDriveItem: new Map<string, unknown>(),
	directoryUuidToAnyNormalDir: new Map<string, unknown>(),
	directoryUuidToAnyLinkedDirWithMeta: new Map<string, unknown>()
}))

vi.mock("@/lib/cache", () => ({ default: { uuidToAnyDriveItem: h.uuidToAnyDriveItem } }))
vi.mock("@/lib/decryption", () => ({ driveItemDisplayName: (item: { data: { uuid: string } }) => item.data.uuid }))
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: {} }))
vi.mock("@filen/sdk-rs", () => ({ PasswordState: {}, AnyLinkedDir: {} }))

import { resolveDriveHeaderTitle } from "@/features/drive/utils"
import { compileWithReactCompiler, compilerFailures, requireFromBabelPreset } from "@/tests/compileWithReactCompiler"

function withDefault<T>(value: T): { __esModule: true; default: T } {
	return { __esModule: true, default: value }
}

// The compiled output is CommonJS: run it with its require answered from the stubs.
function runCompiled<T>(code: string, modules: Record<string, unknown>, label: string): T {
	const module = { exports: {} as T }
	const load = (id: string): unknown => {
		if (id in modules) {
			return modules[id]
		}

		if (id.startsWith("@babel/runtime/")) {
			return requireFromBabelPreset(id)
		}

		throw new Error(`The compiled ${label} imports ${id}, which this test doesn't stub`)
	}

	compileFunction(code, ["require", "module", "exports"])(load, module, module.exports)

	return module.exports
}

describe("React Compiler coverage of the drive hot path", () => {
	it("compiles useDrivePath", () => {
		const { events } = compileWithReactCompiler("hooks/useDrivePath.ts")

		expect(compilerFailures(events)).toEqual([])
		expect(events.some(event => event.kind === "CompileSuccess" && event.fnName === "useDrivePath" && (event.memoSlots ?? 0) > 0)).toBe(
			true
		)
	})

	it.each([
		"features/drive/components/index.tsx",
		"features/drive/components/header.tsx",
		"features/drive/components/item/index.tsx",
		"features/drive/components/item/menu.tsx",
		"features/drive/hooks/useSortedDriveItems.ts"
	])("compiles every component in %s", file => {
		const { events } = compileWithReactCompiler(file)

		expect(compilerFailures(events)).toEqual([])
		expect(events.some(event => event.kind === "CompileSuccess")).toBe(true)
	})

	// renderItem captures getListItems, so a getter keyed on the listing would hand FlashList a new renderItem on every
	// listing update and re-render every visible row.
	it("caches Drive's getListItems once for the screen's lifetime", () => {
		const { code } = compileWithReactCompiler("features/drive/components/index.tsx")

		expect(code).toMatch(
			/===\s*Symbol\.for\("react\.memo_cache_sentinel"\)\s*\)\s*\{\s*\w+\s*=\s*\(\)\s*=>\s*listItemsRef\.current\s*;/
		)
	})

	// A component the compiler skips runs unmemoized: every row menu rebuilds its native config on each render, and the
	// text editor reconfigures CodeMirror on every keystroke.
	it.each(["components/ui/menu.tsx", "components/textEditor/dom.tsx"])("compiles every component in %s", file => {
		const { events } = compileWithReactCompiler(file)

		expect(compilerFailures(events)).toEqual([])
		expect(events.some(event => event.kind === "CompileSuccess")).toBe(true)
	})
})

// The compiled Header, rendered through one memo cache the way React keeps it across renders. Its title, create menu
// and Save to Cloud Drive read the uuid caches, which React can't see: a memoized value is only computed again when an
// input changes.
describe("the compiled drive Header", () => {
	type HeaderProps = {
		setSearchQuery: (query: string) => void
		listItems: DriveItem[]
		searchStatus: "idle"
		listingFetchStatus: FetchStatus
	}

	type StackHeaderProps = {
		title: string
		rightItems: { buttons?: { id: string }[] }[]
	}

	const DIRECTORY_UUID = "0b7c4f1e-3a52-4d8e-9f61-2c5d8a7e4b90"
	const LINK = { uuid: "5e2a9c7d-1f3b-4c8e-a6d0-9b4f2e7c1a35", key: "key", rootName: "Holidays" }
	const NO_ITEMS: DriveItem[] = []
	const t = ((key: string) => key) as unknown as TFunction
	const translation = { t }
	const classNames = { color: "#000000", backgroundColor: "#ffffff" }
	const navigation = { getState: () => ({ index: 0 }) }
	const client = { rootUuid: "root-uuid" }
	const sortPreference = { sort: "nameAsc", setSort: () => {}, sortable: true }
	const viewMode = { viewMode: "list", setViewMode: () => {} }
	const upload = {}
	const setSearchQuery = () => {}
	const { code } = compileWithReactCompiler("features/drive/components/header.tsx")

	// Mounts the compiled Header with every import stubbed to return the same values each render, like the real
	// hooks do while nothing changes; the drive path is the stable one the compiled useDrivePath returns.
	function mountHeader(drivePath: DrivePath) {
		const memoSentinel = Symbol.for("react.memo_cache_sentinel")
		let memo: unknown[] | null = null
		const resolveTitle = vi.fn(resolveDriveHeaderTitle)
		// Like linkedDirectoryCopySource: a linked subdirectory is saveable once its parent's listing has cached it.
		const buildSaveButton = vi.fn(({ drivePath: path }: { drivePath: DrivePath }) =>
			h.directoryUuidToAnyLinkedDirWithMeta.has(path.uuid ?? "") ? { id: "saveDirectoryToCloudDrive" } : null
		)
		const storeState = { selectedItems: NO_ITEMS, syncing: false, entry: null }
		const modules: Record<string, unknown> = {
			"react/compiler-runtime": {
				c: (size: number) => (memo ??= new Array<unknown>(size).fill(memoSentinel))
			},
			"react/jsx-runtime": {
				jsx: (type: unknown, props: unknown) => ({ type, props }),
				jsxs: (type: unknown, props: unknown) => ({ type, props })
			},
			"expo-router": { useNavigation: () => navigation },
			"@/lib/router": { router: { push: () => {}, back: () => {} } },
			"react-i18next": { useTranslation: () => translation },
			uniwind: { useResolveClassNames: () => classNames },
			"react-native": { Platform: { OS: "ios" } },
			"zustand/shallow": { useShallow: (selector: unknown) => selector },
			"@/components/ui/header": withDefault("StackHeader"),
			"@/hooks/useDrivePath": withDefault(() => drivePath),
			"@/features/drive/driveSortPreference": { useDriveSortPreference: () => sortPreference },
			"@/features/drive/driveViewModePreference": { useDriveViewMode: () => viewMode },
			"@/lib/alerts": withDefault({}),
			"@/lib/promptFlow": { confirmPrompt: () => {} },
			"@/components/ui/fullScreenLoadingModal": { runWithLoading: () => {} },
			"@/features/drive/drive": withDefault({}),
			"@/features/drive/store/useDrive.store": withDefault((selector: (state: typeof storeState) => unknown) => selector(storeState)),
			"@/lib/auth": { useStringifiedClient: () => client },
			"@/features/offline/offlineSync": withDefault({}),
			"@/features/offline/store/useOffline.store": withDefault((selector: (state: typeof storeState) => unknown) =>
				selector(storeState)
			),
			"@/features/drive/driveSelectors": {
				aggregateDriveSelectionFlags: () => ({}),
				isPlainDrivePath: (drivePath: DrivePath) => drivePath.type === "drive" && !drivePath.selectOptions
			},
			"@/features/drive/utils": { resolveDriveHeaderTitle: resolveTitle },
			"@/features/drive/hooks/useDriveUpload": { useDriveUpload: () => upload },
			"@/features/drive/components/headerMenuBuilders": {
				buildSortMenuButton: () => ({ id: "sort" }),
				buildBulkActionMenu: () => [],
				buildViewModeMenuButton: () => ({ id: "viewMode" })
			},
			"@/features/drive/components/driveCreateMenu": {
				getDriveParent: (path: DrivePath) => h.directoryUuidToAnyNormalDir.get(path.uuid ?? "") ?? null,
				canShowDriveCreateMenu: ({ parent }: { parent: unknown }) => parent !== null,
				buildDriveCreateMenuButtons: () => [{ id: "createFolder" }]
			},
			"@/features/drive/store/useDriveClipboard.store": withDefault((selector: (state: typeof storeState) => unknown) =>
				selector(storeState)
			),
			// A link someone else owns, whose downloads are allowed.
			"@/features/drive/hooks/useLinkSaveable": withDefault(() => drivePath.type === "linked"),
			"@/features/drive/linkedSave": { buildSaveLinkedDirectoryButton: buildSaveButton, linkSaveTarget: () => null },
			"@/lib/logger": withDefault({})
		}
		const Header = runCompiled<{ default?: (props: HeaderProps) => { props: StackHeaderProps } }>(code, modules, "Header").default

		if (!Header) {
			throw new Error("The compiled Header has no default export")
		}

		return {
			title: (props: HeaderProps) => Header(props).props.title,
			menuIds: (props: HeaderProps) =>
				Header(props)
					.props.rightItems.flatMap(item => item.buttons ?? [])
					.map(button => button.id),
			resolveTitle,
			buildSaveButton
		}
	}

	beforeEach(() => {
		h.uuidToAnyDriveItem.clear()
		h.directoryUuidToAnyNormalDir.clear()
		h.directoryUuidToAnyLinkedDirWithMeta.clear()
	})

	it("names a directory reached by uuid alone once its listing's fetch has cached it", () => {
		const header = mountHeader({ type: "drive", uuid: DIRECTORY_UUID })

		expect(header.title({ setSearchQuery, listItems: NO_ITEMS, searchStatus: "idle", listingFetchStatus: "fetching" })).toBe("drive")

		// fetchData's by-uuid lookup caches the directory, then its listing lands.
		h.uuidToAnyDriveItem.set(DIRECTORY_UUID, {
			type: "directory",
			data: { uuid: DIRECTORY_UUID, decryptedMeta: { name: "Holidays" } }
		})

		const listing = [{ type: "file", data: { uuid: "child", decryptedMeta: { name: "a.jpg" } } }] as unknown as DriveItem[]

		expect(header.title({ setSearchQuery, listItems: listing, searchStatus: "idle", listingFetchStatus: "idle" })).toBe("Holidays")
	})

	it("offers create and upload once the directory is cached: its parent lookup isn't memoized", () => {
		const header = mountHeader({ type: "drive", uuid: DIRECTORY_UUID })

		expect(header.menuIds({ setSearchQuery, listItems: NO_ITEMS, searchStatus: "idle", listingFetchStatus: "fetching" })).not.toContain(
			"createFolder"
		)

		h.directoryUuidToAnyNormalDir.set(DIRECTORY_UUID, { tag: "Dir", inner: [{ uuid: DIRECTORY_UUID }] })

		expect(header.menuIds({ setSearchQuery, listItems: NO_ITEMS, searchStatus: "idle", listingFetchStatus: "idle" })).toContain(
			"createFolder"
		)
	})

	it("resolves the title once while nothing it depends on changes", () => {
		const header = mountHeader({ type: "drive", uuid: DIRECTORY_UUID })
		const props: HeaderProps = { setSearchQuery, listItems: NO_ITEMS, searchStatus: "idle", listingFetchStatus: "idle" }

		header.title(props)
		header.title(props)

		expect(header.resolveTitle).toHaveBeenCalledOnce()
	})

	it("offers Save to Cloud Drive in a linked subdirectory once its parent's listing has cached it", () => {
		const header = mountHeader({ type: "linked", uuid: DIRECTORY_UUID, linked: LINK })

		// Opened from a restored listing before its parent's read cached it, so its own read failed.
		expect(header.menuIds({ setSearchQuery, listItems: NO_ITEMS, searchStatus: "idle", listingFetchStatus: "idle" })).not.toContain(
			"saveDirectoryToCloudDrive"
		)

		// The parent's read lands, then the subdirectory's retry reads it.
		h.directoryUuidToAnyLinkedDirWithMeta.set(DIRECTORY_UUID, { dir: {}, meta: {} })

		expect(header.menuIds({ setSearchQuery, listItems: NO_ITEMS, searchStatus: "idle", listingFetchStatus: "fetching" })).toContain(
			"saveDirectoryToCloudDrive"
		)
	})

	it("builds Save to Cloud Drive once while nothing it depends on changes", () => {
		const header = mountHeader({ type: "linked", uuid: DIRECTORY_UUID, linked: LINK })
		const props: HeaderProps = { setSearchQuery, listItems: NO_ITEMS, searchStatus: "idle", listingFetchStatus: "idle" }

		h.directoryUuidToAnyLinkedDirWithMeta.set(DIRECTORY_UUID, { dir: {}, meta: {} })
		header.menuIds(props)
		header.menuIds(props)

		expect(header.buildSaveButton).toHaveBeenCalledOnce()
	})
})

// The compiled Menu, each component rendered through its own memo cache the way React keeps them across renders. A
// drive row's menu re-renders whenever its children change (selection mode, the checkbox) while its buttons stay the
// same array.
describe("the compiled Menu", () => {
	type Element = {
		type: unknown
		props: Record<string, unknown>
	}

	type IosMenuConfig = {
		menuItems?: { actionKey: string; menuAttributes?: string[] }[]
	}

	const { code } = compileWithReactCompiler("components/ui/menu.tsx")

	function mountMenu() {
		const memoSentinel = Symbol.for("react.memo_cache_sentinel")
		const caches: unknown[][] = []
		let cursor = 0
		const connectivity = { online: true }
		const modules: Record<string, unknown> = {
			"react/compiler-runtime": {
				c: (size: number) => (caches[cursor++] ??= new Array<unknown>(size).fill(memoSentinel))
			},
			"react/jsx-runtime": {
				jsx: (type: unknown, props: Record<string, unknown>): Element => ({ type, props })
			},
			uniwind: { withUniwind: (component: unknown) => component, useResolveClassNames: () => ({}) },
			"react-native": { Platform: { OS: "ios" } },
			"@react-native-menu/menu": { MenuView: "MenuView" },
			"react-native-ios-context-menu": { ContextMenuView: "ContextMenuView", ContextMenuButton: "ContextMenuButton" },
			"@/components/ui/menuIcons": { iconToSwiftUiIcon: (icon: string) => icon },
			"@/hooks/useIsOnline": withDefault(() => connectivity.online),
			"@/components/ui/longPressMenuGuard": { InsideContextMenuContext: { Provider: "InsideContextMenuContext.Provider" } }
		}
		const Menu = runCompiled<{ default?: (props: Record<string, unknown>) => Element }>(code, modules, "Menu").default

		if (!Menu) {
			throw new Error("The compiled Menu has no default export")
		}

		return {
			connectivity,
			// Renders Menu, then the platform menu it returns, and hands back the native menu config.
			menuConfig: (props: Record<string, unknown>) => {
				cursor = 0

				const inner = Menu(props)

				if (typeof inner.type !== "function") {
					throw new Error("The compiled Menu did not render a platform menu")
				}

				return (inner.type as (props: Record<string, unknown>) => Element)(inner.props).props["menuConfig"] as IosMenuConfig
			}
		}
	}

	const buttons = [
		{ id: "open", title: "Open" },
		{ id: "share", title: "Share", requiresOnline: true }
	]

	it("builds the native menu config once while only its children change", () => {
		const menu = mountMenu()
		const first = menu.menuConfig({ children: "row", buttons })

		expect(menu.menuConfig({ children: "selected row", buttons })).toBe(first)
		expect(first.menuItems?.map(item => item.actionKey)).toEqual(["open", "share"])
	})

	it("rebuilds it when the buttons or connectivity change", () => {
		const menu = mountMenu()
		const first = menu.menuConfig({ children: "row", buttons })
		const changed = menu.menuConfig({ children: "row", buttons: [...buttons, { id: "delete", title: "Delete" }] })

		expect(changed).not.toBe(first)
		expect(changed.menuItems?.map(item => item.actionKey)).toEqual(["open", "share", "delete"])

		menu.connectivity.online = false

		const offline = menu.menuConfig({ children: "row", buttons })

		expect(offline.menuItems?.[1]?.menuAttributes).toEqual(["disabled"])
	})
})
