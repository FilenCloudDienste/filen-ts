// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { File, UuidStr } from "@filen/sdk-rs"

const { moveItems, toast } = vi.hoisted(() => ({
	moveItems: vi.fn(),
	toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() })
}))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("sonner", () => ({ toast }))
vi.mock("@/features/drive/lib/actions", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/lib/actions")>()),
	moveItems
}))

import "@/lib/i18n"
import { narrowItem } from "@/features/drive/lib/item"
import { performMove } from "@/features/drive/lib/dnd"
import { useDriveStore } from "@/features/drive/store/useDriveStore"

function file(name: string) {
	return narrowItem({
		uuid: `${name}-0000-0000-0000-000000000000` as UuidStr,
		stableUUID: undefined,
		parent: "home-0000-0000-0000-000000000000" as UuidStr,
		size: 1n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name, mime: "text/plain", modified: 0n, size: 1n, key: "k", version: 2 } }
	} satisfies File)
}

const DOCS = { uuid: "docs-0000-0000-0000-000000000000", name: "Docs" }

beforeEach(() => {
	vi.clearAllMocks()
	useDriveStore.setState({ selectedItems: [] })
})

describe("performMove", () => {
	it("runs as an activity named by the destination, then prunes what moved from the selection", async () => {
		const moved = file("a.txt")
		const stuck = file("b.txt")
		const error = { species: "plain", message: "no", label: "no" }
		useDriveStore.setState({ selectedItems: [moved, stuck] })
		moveItems.mockResolvedValueOnce({ succeeded: [moved], failed: [{ item: stuck, error }] })

		const outcome = await performMove([moved, stuck], DOCS)

		expect(moveItems).toHaveBeenCalledExactlyOnceWith([moved, stuck], DOCS.uuid, expect.any(Function))
		expect(toast).toHaveBeenCalledWith("Moving 2 items to Docs", expect.anything())
		expect(toast.error).toHaveBeenCalledExactlyOnceWith("Moved 1 item to Docs, 1 failed", expect.anything())
		expect(outcome.failed).toEqual([{ item: stuck, error }])
		expect(useDriveStore.getState().selectedItems).toEqual([stuck])
	})

	it("names the one item it moves", async () => {
		const only = file("a.txt")
		moveItems.mockResolvedValueOnce({ succeeded: [only], failed: [] })

		await performMove([only], { uuid: null, name: "Cloud Drive" })

		expect(moveItems).toHaveBeenCalledExactlyOnceWith([only], null, expect.any(Function))
		expect(toast.success).toHaveBeenCalledExactlyOnceWith("Moved a.txt to Cloud Drive", expect.anything())
	})

	it("does nothing for an empty payload", async () => {
		expect(await performMove([], DOCS)).toEqual({ succeeded: [], failed: [] })
		expect(moveItems).not.toHaveBeenCalled()
		expect(toast).not.toHaveBeenCalled()
	})
})
