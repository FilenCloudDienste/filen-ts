// @vitest-environment jsdom

// The Undo a drive trash or move offers on its result toast: it puts back exactly the items the action changed, from
// what was held before it ran.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { ExternalToast } from "sonner"
import type { File, UuidStr } from "@filen/sdk-rs"
import "@/lib/i18n"

const { moveItems, restoreItems, trashItems, toast } = vi.hoisted(() => ({
	moveItems: vi.fn(),
	restoreItems: vi.fn(),
	trashItems: vi.fn(),
	toast: Object.assign(vi.fn(), {
		success: vi.fn<(title: string, options?: ExternalToast) => string>(),
		error: vi.fn<(title: string, options?: ExternalToast) => string>(),
		dismiss: vi.fn()
	})
}))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("sonner", () => ({ toast }))
vi.mock("@/features/drive/lib/actions", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/lib/actions")>()),
	currentRootUuid: () => ROOT,
	moveItems,
	restoreItems,
	trashItems
}))

import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { DRIVE_TRASH, driveActivity } from "@/features/drive/lib/activity"
import { moveActivity } from "@/features/drive/lib/dnd"
import { moveItemsBack, undoTrash } from "@/features/drive/lib/undo"
import { runBulkActivity } from "@/lib/activity/activity"

const ROOT = "root-0000-0000-0000-000000000000"
const HOME = "home-0000-0000-0000-000000000000"
const WORK = "work-0000-0000-0000-000000000000"
const DOCS = "docs-0000-0000-0000-000000000000"

function file(name: string, parent: string): DriveItem {
	return narrowItem({
		uuid: `${name}-0000-0000-0000-000000000000` as UuidStr,
		stableUUID: undefined,
		parent: parent as UuidStr,
		size: 1n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name, mime: "text/plain", modified: 0n, size: 1n, key: "key", version: 2 } }
	} satisfies File)
}

function allSucceed(items: DriveItem[]): Promise<{ succeeded: DriveItem[]; failed: [] }> {
	return Promise.resolve({ succeeded: items, failed: [] })
}

function lastUndo(): () => void {
	const action = toast.success.mock.lastCall?.[1]?.action

	if (action === undefined || action === null || typeof action !== "object" || !("onClick" in action) || action.label !== "Undo") {
		throw new Error("no Undo action")
	}

	return () => {
		action.onClick({} as never)
	}
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe("trash undo", () => {
	it("restores exactly the trashed items, a whole selection at once", async () => {
		const items = [file("a", HOME), file("b", WORK), file("c", HOME)]
		trashItems.mockImplementation(allSucceed)
		restoreItems.mockImplementation(allSucceed)

		await runBulkActivity(driveActivity(items, DRIVE_TRASH, trashItems, { undo: undoTrash }))

		expect(toast.success).toHaveBeenCalledWith("Moved 3 items to trash", expect.anything())

		lastUndo()()

		await vi.waitFor(() => {
			expect(toast.success).toHaveBeenCalledWith("Restored 3 items", expect.anything())
		})
		expect(restoreItems).toHaveBeenCalledOnce()
		expect(restoreItems.mock.calls[0]?.[0]).toEqual(items)
	})

	it("offers Try again instead of Undo when an item failed", async () => {
		const items = [file("a", HOME), file("b", HOME)]
		const [ok, bad] = items
		trashItems.mockResolvedValue({ succeeded: [ok], failed: [{ item: bad, error: new Error("nope") }] })

		await runBulkActivity(driveActivity(items, DRIVE_TRASH, trashItems, { undo: undoTrash }))

		expect(toast.error.mock.lastCall?.[1]?.action).toMatchObject({ label: "Try again" })
		expect(toast.success).not.toHaveBeenCalled()
	})
})

describe("move undo", () => {
	it("moves each item back to the parent it came from, grouped by parent", async () => {
		const items = [file("a", HOME), file("b", WORK), file("c", HOME)]
		moveItems.mockImplementation(allSucceed)

		await runBulkActivity(moveActivity(items, { uuid: DOCS, name: "Docs" }))

		expect(toast.success).toHaveBeenCalledWith("Moved 3 items to Docs", expect.anything())
		moveItems.mockClear()

		lastUndo()()

		await vi.waitFor(() => {
			expect(toast.success).toHaveBeenCalledWith("Moved 3 items back", expect.anything())
		})
		expect(
			moveItems.mock.calls.map((call): unknown[] => [(call[0] as DriveItem[]).map(item => item.data.uuid), call[1] as string])
		).toEqual([
			[[items[0]?.data.uuid, items[2]?.data.uuid], HOME],
			[[items[1]?.data.uuid], WORK]
		])
	})

	it("leaves out an item already in the destination, and offers nothing when none moved", async () => {
		moveItems.mockImplementation(allSucceed)

		await runBulkActivity(moveActivity([file("a", ROOT)], { uuid: null, name: "Cloud Drive" }))

		expect(toast.success.mock.lastCall?.[1]?.action).toBeUndefined()
	})

	it("counts the parallel groups as one run", async () => {
		moveItems.mockImplementation((group: DriveItem[], _parent: string, onSettled: () => void) => {
			group.forEach(() => {
				onSettled()
			})

			return allSucceed(group)
		})
		const progress = vi.fn()

		const outcome = await moveItemsBack([file("a", HOME), file("b", WORK)], progress)

		expect(outcome.succeeded).toHaveLength(2)
		expect(progress.mock.calls).toEqual([
			[1, 2],
			[2, 2]
		])
	})
})
