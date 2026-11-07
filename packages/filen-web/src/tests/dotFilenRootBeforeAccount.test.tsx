// @vitest-environment jsdom

// The root `.filen` hides in every view that can list it before the account has loaded: its root comes from the
// session (queries/driveRoot.ts), a worker read with no request, never from getUserInfo.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import type { Dir, File, UuidStr } from "@filen/sdk-rs"

const { driveRootUuid, getUserInfo } = vi.hoisted(() => ({
	driveRootUuid: vi.fn<() => Promise<string | null>>(),
	getUserInfo: vi.fn<() => Promise<never>>()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { driveRootUuid, getUserInfo } }))
vi.mock("@/queries/client", async () => ({ queryClient: (await import("@/tests/testQueryClient")).createTestQueryClient() }))
vi.mock("@/features/drive/lib/preferences", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/lib/preferences")>()),
	getShowDotFilen: () => Promise.resolve(false)
}))

import { queryClient } from "@/queries/client"
import { queryClientWrapper } from "@/tests/testQueryClient"
import { DRIVE_ROOT_UUID_QUERY_KEY, driveRootUuidGet, warmDriveRootUuid } from "@/queries/driveRoot"
import { accountQueryGet } from "@/queries/account"
import { useHiddenDotFilenRoot } from "@/features/drive/queries/drive"
import { resolveListingDisplayItems } from "@/features/drive/components/directoryListing.logic"
import { dotFilenFilterAppliesTo } from "@/features/drive/lib/hiddenItems"
import { isRootDotFilenItem } from "@/features/drive/lib/dotFilenGuard"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import type { DriveVariant } from "@/features/drive/lib/preferences"

const ROOT = "a0000000-0000-4000-8000-000000000001" as UuidStr
const NO_SIZES: ReadonlyMap<string, number> = new Map()

function dir(uuid: string, name: string, parent: string = ROOT): DriveItem {
	return narrowItem({
		uuid: uuid as UuidStr,
		parent: parent as UuidStr,
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "decoded", data: { name } }
	} satisfies Dir)
}

function file(uuid: string, name: string): DriveItem {
	return narrowItem({
		uuid: uuid as UuidStr,
		stableUUID: undefined,
		parent: ROOT,
		size: 1n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name, mime: "text/plain", modified: 1_700_000_000_000n, size: 1n, key: "key", version: 2 } }
	} satisfies File)
}

const dotFilen = dir("b0000000-0000-4000-8000-000000000002", ".filen")
const docs = dir("c0000000-0000-4000-8000-000000000003", "Docs")
const notes = file("d0000000-0000-4000-8000-000000000004", "notes.txt")

async function hiddenRootBeforeAccount(): Promise<string | null> {
	const { result } = renderHook(() => useHiddenDotFilenRoot(), { wrapper: queryClientWrapper(queryClient) })

	await waitFor(() => {
		expect(result.current).toBe(ROOT)
	})

	return result.current
}

beforeEach(() => {
	queryClient.clear()
	driveRootUuid.mockReset().mockResolvedValue(ROOT)
	// The account never answers in these tests.
	getUserInfo.mockReset().mockReturnValue(new Promise<never>(() => undefined))
})

describe("the root .filen before the account has loaded", () => {
	it("is named by the session's root, with no account read", async () => {
		await hiddenRootBeforeAccount()

		expect(accountQueryGet()).toBeUndefined()
		expect(getUserInfo).not.toHaveBeenCalled()
		expect(driveRootUuid).toHaveBeenCalledOnce()
	})

	it.each<{ view: string; variant: DriveVariant; atDriveRoot?: boolean; search?: boolean }>([
		{ view: "the drive root", variant: "drive", atDriveRoot: true },
		{ view: "a search rooted at the drive root", variant: "drive", atDriveRoot: true, search: true },
		{ view: "recents", variant: "recents" },
		{ view: "favorites", variant: "favorites" },
		{ view: "links", variant: "links" }
	])("is hidden in $view", async ({ variant, atDriveRoot, search }) => {
		const root = await hiddenRootBeforeAccount()

		expect(dotFilenFilterAppliesTo(variant, null)).toBe(true)

		const result = resolveListingDisplayItems({
			items: [dotFilen, docs, notes],
			sortBy: "nameAsc",
			directorySizes: NO_SIZES,
			hide: false,
			dotFilenRoot: root,
			atDriveRoot: atDriveRoot === true,
			variant,
			...(search === true ? { search: { total: 3n, parentPaths: new Map<string, string>() } } : {})
		})

		expect(result.items.map(item => item.data.uuid)).toEqual([docs.data.uuid, notes.data.uuid])
	})

	it("is never filtered where it cannot be the root one, or stays restorable", () => {
		for (const variant of ["trash", "sharedIn", "sharedOut"] as const) {
			expect(dotFilenFilterAppliesTo(variant, null)).toBe(false)
		}

		expect(dotFilenFilterAppliesTo("drive", docs.data.uuid)).toBe(false)
	})

	it("is guarded as the root one (its confirm, its place first) from the session's root", async () => {
		await warmDriveRootUuid()

		expect(driveRootUuidGet()).toBe(ROOT)
		expect(isRootDotFilenItem(dotFilen)).toBe(true)
		expect(isRootDotFilenItem(dir("e0000000-0000-4000-8000-000000000005", ".filen", docs.data.uuid))).toBe(false)
	})

	it("is warmed at boot, so a first render reads it without a fetch of its own", async () => {
		await warmDriveRootUuid()

		expect(queryClient.getQueryData(DRIVE_ROOT_UUID_QUERY_KEY)).toBe(ROOT)

		const { result } = renderHook(() => useHiddenDotFilenRoot(), { wrapper: queryClientWrapper(queryClient) })

		await waitFor(() => {
			expect(result.current).toBe(ROOT)
		})
		expect(driveRootUuid).toHaveBeenCalledOnce()
	})

	it("never caches a read made before the session is in", async () => {
		driveRootUuid.mockResolvedValueOnce(null)

		await warmDriveRootUuid()

		expect(queryClient.getQueryData(DRIVE_ROOT_UUID_QUERY_KEY)).toBeUndefined()
	})
})
