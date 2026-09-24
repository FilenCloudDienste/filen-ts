import { vi, describe, it, expect, beforeEach } from "vitest"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
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
	directoryUuidToAnyNormalDir: new Map<string, unknown>()
}))

vi.mock("@/lib/cache", () => ({ default: { uuidToAnyDriveItem: h.uuidToAnyDriveItem } }))
vi.mock("@/lib/decryption", () => ({ driveItemDisplayName: (item: { data: { uuid: string } }) => item.data.uuid }))
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: {} }))
vi.mock("@filen/sdk-rs", () => ({ PasswordState: {}, AnyLinkedDir: {} }))

import { resolveDriveHeaderTitle } from "@/features/drive/utils"

type CompilerEvent = {
	kind: string
	fnName: string | null
	memoSlots?: number
	detail?: unknown
}

type BabelCore = {
	transformFileSync: (filename: string, options: Record<string, unknown>) => { code?: string | null } | null
}

const requireHere = createRequire(import.meta.url)
// babel-preset-expo only peers @babel/core; Metro's comes through expo's own metro-config.
const requireMetroConfig = createRequire(createRequire(requireHere.resolve("expo/package.json")).resolve("@expo/metro-config/package.json"))
const babel = requireMetroConfig("@babel/core") as BabelCore
const babelPresetExpo = requireHere.resolve("babel-preset-expo")
// The @babel/runtime helpers the compiled output requires, as the preset that emits them resolves them.
const requireFromPreset = createRequire(babelPresetExpo)

function compile(file: string): { events: CompilerEvent[]; code: string } {
	const events: CompilerEvent[] = []

	const result = babel.transformFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), {
		babelrc: false,
		configFile: false,
		presets: [
			[
				babelPresetExpo,
				{
					"react-compiler": {
						logger: {
							logEvent: (_filename: string | null, event: CompilerEvent) => {
								events.push(event)
							}
						}
					}
				}
			]
		],
		caller: {
			name: "metro",
			bundler: "metro",
			platform: "ios",
			isDev: false,
			isServer: false,
			supportsReactCompiler: true
		}
	})

	if (!result?.code) {
		throw new Error(`${file} produced no output`)
	}

	return {
		events,
		code: result.code
	}
}

function failures(events: CompilerEvent[]): CompilerEvent[] {
	return events.filter(event => event.kind !== "CompileSuccess")
}

describe("React Compiler coverage of the drive hot path", () => {
	it("compiles useDrivePath", () => {
		const { events } = compile("hooks/useDrivePath.ts")

		expect(failures(events)).toEqual([])
		expect(events.some(event => event.kind === "CompileSuccess" && event.fnName === "useDrivePath" && (event.memoSlots ?? 0) > 0)).toBe(
			true
		)
	})

	it.each(["features/drive/components/index.tsx", "features/drive/components/header.tsx", "features/drive/components/item/index.tsx", "features/drive/components/item/menu.tsx"])(
		"compiles every component in %s",
		file => {
			const { events } = compile(file)

			expect(failures(events)).toEqual([])
			expect(events.some(event => event.kind === "CompileSuccess")).toBe(true)
		}
	)
})

// The compiled Header, rendered through one memo cache the way React keeps it across renders. Its title and create
// menu read the uuid caches, which React can't see: a memoized value is only computed again when an input changes.
describe("the compiled drive Header", () => {
	type HeaderProps = {
		setSearchQuery: (query: string) => void
		listItems: DriveItem[]
		searchStatus: "idle"
		listingFetchStatus: FetchStatus
	}

	type StackHeaderProps = {
		title: string
		rightItems: { props?: { buttons?: { id: string }[] } }[]
	}

	const DIRECTORY_UUID = "0b7c4f1e-3a52-4d8e-9f61-2c5d8a7e4b90"
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
	const { code } = compile("features/drive/components/header.tsx")

	function withDefault<T>(value: T): { __esModule: true; default: T } {
		return { __esModule: true, default: value }
	}

	// Mounts the compiled Header with every import stubbed to return the same values each render, like the real
	// hooks do while nothing changes; the drive path is the stable one the compiled useDrivePath returns.
	function mountHeader(drivePath: DrivePath) {
		const memoSentinel = Symbol.for("react.memo_cache_sentinel")
		let memo: unknown[] | null = null
		const resolveTitle = vi.fn(resolveDriveHeaderTitle)
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
			"@filen/shared": { run: () => {} },
			"@/components/ui/header": withDefault("StackHeader"),
			"@/hooks/useDrivePath": withDefault(() => drivePath),
			"@/features/drive/driveSortPreference": { useDriveSortPreference: () => sortPreference },
			"@/features/drive/driveViewModePreference": { useDriveViewMode: () => viewMode },
			"@/lib/alerts": withDefault({}),
			"@/lib/prompts": withDefault({}),
			"@/components/ui/fullScreenLoadingModal": { runWithLoading: () => {} },
			"@/features/drive/drive": withDefault({}),
			"@/features/drive/store/useDrive.store": withDefault((selector: (state: typeof storeState) => unknown) => selector(storeState)),
			"@/lib/auth": { useStringifiedClient: () => client },
			"@/features/offline/offlineSync": withDefault({}),
			"@/features/offline/store/useOffline.store": withDefault((selector: (state: typeof storeState) => unknown) => selector(storeState)),
			"@/features/drive/driveSelectors": { aggregateDriveSelectionFlags: () => ({}) },
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
			"@/features/drive/hooks/useLinkSaveable": withDefault(() => false),
			"@/features/drive/linkedSave": { buildSaveLinkedDirectoryButton: () => null, linkSaveTarget: () => null },
			"@/lib/logger": withDefault({})
		}
		const module = { exports: {} as { default?: (props: HeaderProps) => { props: StackHeaderProps } } }
		const load = (id: string): unknown => {
			if (id in modules) {
				return modules[id]
			}

			if (id.startsWith("@babel/runtime/")) {
				return requireFromPreset(id)
			}

			throw new Error(`The compiled Header imports ${id}, which this test doesn't stub`)
		}

		// The compiled output is CommonJS: run it with its require answered from the stubs.
		compileFunction(code, ["require", "module", "exports"])(load, module, module.exports)

		const Header = module.exports.default

		if (!Header) {
			throw new Error("The compiled Header has no default export")
		}

		return {
			title: (props: HeaderProps) => Header(props).props.title,
			menuIds: (props: HeaderProps) =>
				Header(props)
					.props.rightItems.flatMap(item => item.props?.buttons ?? [])
					.map(button => button.id),
			resolveTitle
		}
	}

	beforeEach(() => {
		h.uuidToAnyDriveItem.clear()
		h.directoryUuidToAnyNormalDir.clear()
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

		expect(header.menuIds({ setSearchQuery, listItems: NO_ITEMS, searchStatus: "idle", listingFetchStatus: "idle" })).toContain("createFolder")
	})

	it("resolves the title once while nothing it depends on changes", () => {
		const header = mountHeader({ type: "drive", uuid: DIRECTORY_UUID })
		const props: HeaderProps = { setSearchQuery, listItems: NO_ITEMS, searchStatus: "idle", listingFetchStatus: "idle" }

		header.title(props)
		header.title(props)

		expect(header.resolveTitle).toHaveBeenCalledOnce()
	})
})
