import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Dir, UuidStr } from "@filen/sdk-rs"
import { DRIVE_RESTORE, DRIVE_TRASH, driveActivity } from "@/features/drive/lib/activity"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { useDriveStore } from "@/features/drive/store/useDriveStore"
import { testUuid } from "@/tests/support/uuid"

function directoryItem(uuid: UuidStr): DriveItem {
	const dir: Dir = {
		uuid,
		parent: testUuid("parent"),
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "decoded", data: { name: uuid } }
	}

	return narrowItem(dir)
}

const a = directoryItem(testUuid("a"))
const b = directoryItem(testUuid("b"))
const c = directoryItem(testUuid("c"))

function selectedUuids(): string[] {
	return useDriveStore.getState().selectedItems.map(item => item.data.uuid)
}

function finish(spec: ReturnType<typeof driveActivity<DriveItem>>, succeeded: DriveItem[], failed: DriveItem[] = []): void {
	spec.onDone?.({ succeeded, failed: failed.map(item => ({ item, error: new Error("failed") })) })
}

const run = vi.fn()

beforeEach(() => {
	useDriveStore.setState({ selectedItems: [], pendingReveal: null })
})

describe("driveActivity selection prune", () => {
	it("drops the succeeded items that stayed selected and keeps the failed ones", () => {
		useDriveStore.getState().setSelectedItems([a, b, c])

		finish(driveActivity([a, b], DRIVE_TRASH, run), [a], [b])

		expect(selectedUuids()).toEqual([b.data.uuid, c.data.uuid])
	})

	it("keeps an item that left the selection and was selected again while the action ran", () => {
		// The restore's rows leave the trash, the user opens their directory and selects them there.
		useDriveStore.getState().setSelectedItems([a, b])

		const spec = driveActivity([a, b], DRIVE_RESTORE, run)

		useDriveStore.getState().clearSelectedItems()
		useDriveStore.getState().setSelectedItems([a, b])
		finish(spec, [a, b])

		expect(selectedUuids()).toEqual([a.data.uuid, b.data.uuid])
	})

	it("keeps an item selected only after the action started", () => {
		const spec = driveActivity([a], DRIVE_TRASH, run)

		useDriveStore.getState().setSelectedItems([a])
		finish(spec, [a])

		expect(selectedUuids()).toEqual([a.data.uuid])
	})

	it("a Try again still prunes a failed item that stayed selected throughout", () => {
		useDriveStore.getState().setSelectedItems([a, b])

		const spec = driveActivity([a, b], DRIVE_TRASH, run)

		finish(spec, [a], [b])
		expect(selectedUuids()).toEqual([b.data.uuid])

		finish(spec, [b])
		expect(selectedUuids()).toEqual([])
	})

	it("stops watching the selection once nothing it tracks is left", () => {
		useDriveStore.getState().setSelectedItems([a])

		const subscribe = useDriveStore.subscribe
		const unsubscribe = vi.fn()

		vi.spyOn(useDriveStore, "subscribe").mockImplementation(listener => {
			const stop = subscribe(listener)

			unsubscribe.mockImplementation(stop)

			return unsubscribe
		})

		const spec = driveActivity([a], DRIVE_TRASH, run)

		expect(unsubscribe).not.toHaveBeenCalled()

		finish(spec, [a])

		expect(unsubscribe).toHaveBeenCalledTimes(1)
	})

	it("watches nothing for an action over unselected items", () => {
		const subscribe = vi.spyOn(useDriveStore, "subscribe")

		driveActivity([a], DRIVE_TRASH, run)

		expect(subscribe).not.toHaveBeenCalled()
	})

	it("a custom prune gets every succeeded item, tracked or not", () => {
		const prune = vi.fn()

		finish(driveActivity([a], DRIVE_TRASH, run, { prune }), [a])

		expect(prune).toHaveBeenCalledWith([a])
	})
})
