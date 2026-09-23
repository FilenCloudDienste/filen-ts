import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Dir, UuidStr } from "@filen/sdk-rs"

const { performMove, startCopyWithCard, toastSuccess } = vi.hoisted(() => ({
	performMove: vi.fn(),
	startCopyWithCard: vi.fn(),
	toastSuccess: vi.fn()
}))

vi.mock("@/features/drive/lib/dnd", () => ({ performMove }))
vi.mock("@/features/transfers/lib/copyToast", () => ({ startCopyWithCard }))
vi.mock("sonner", () => ({ toast: { success: toastSuccess } }))

import "@/lib/i18n"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { copyToClipboard, cutToClipboard, pasteClipboard } from "@/features/drive/lib/clipboard"
import { useDriveClipboardStore } from "@/features/drive/store/useDriveClipboardStore"

function dirItem(label: string): DriveItem {
	return narrowItem({
		uuid: `${label}-0000-0000-0000-000000000000` as UuidStr,
		parent: "home-0000-0000-0000-000000000000" as UuidStr,
		color: "default",
		timestamp: 0n,
		favorited: false,
		meta: { type: "decoded", data: { name: label } }
	} satisfies Dir)
}

const DOCS = dirItem("docs")
const PHOTOS = dirItem("photos")
const DESTINATION = { uuid: "dest-0000-0000-0000-000000000000", name: "dest" }

function entry() {
	return useDriveClipboardStore.getState().entry
}

beforeEach(() => {
	useDriveClipboardStore.getState().clear()
})

describe("drive clipboard", () => {
	it("holds what was copied or cut last, and says so", () => {
		copyToClipboard([DOCS, PHOTOS])

		expect(entry()).toEqual({ mode: "copy", items: [DOCS, PHOTOS] })
		expect(toastSuccess).toHaveBeenLastCalledWith("2 items ready to paste")

		cutToClipboard([DOCS])

		expect(entry()).toEqual({ mode: "cut", items: [DOCS] })
		expect(toastSuccess).toHaveBeenLastCalledWith("1 item cut — paste it to move it")
	})

	it("pastes a copy as a copy job and keeps it for further pastes", async () => {
		copyToClipboard([DOCS])

		await pasteClipboard(DESTINATION)
		await pasteClipboard(DESTINATION)

		expect(startCopyWithCard).toHaveBeenCalledTimes(2)
		expect(startCopyWithCard).toHaveBeenLastCalledWith([DOCS], DESTINATION)
		expect(performMove).not.toHaveBeenCalled()
		expect(entry()?.mode).toBe("copy")
	})

	it("pastes a cut as a move, emptying the clipboard before the move settles", async () => {
		let settle: (outcome: unknown) => void = () => undefined
		performMove.mockReturnValue(
			new Promise(resolve => {
				settle = resolve
			})
		)
		cutToClipboard([DOCS, PHOTOS])

		const pasted = pasteClipboard(DESTINATION)

		// A second paste while the first is still moving has nothing to move again.
		expect(entry()).toBeNull()

		settle({ succeeded: [DOCS, PHOTOS], failed: [] })
		await pasted

		expect(performMove).toHaveBeenCalledExactlyOnceWith([DOCS, PHOTOS], DESTINATION.uuid)
		expect(startCopyWithCard).not.toHaveBeenCalled()
		expect(entry()).toBeNull()
	})

	it("keeps what failed to move on the clipboard, unless something else was copied meanwhile", async () => {
		performMove.mockResolvedValue({ succeeded: [DOCS], failed: [{ item: PHOTOS, error: new Error("no") }] })
		cutToClipboard([DOCS, PHOTOS])

		await pasteClipboard(DESTINATION)

		expect(entry()).toEqual({ mode: "cut", items: [PHOTOS] })

		let settle: (outcome: unknown) => void = () => undefined
		performMove.mockReturnValue(
			new Promise(resolve => {
				settle = resolve
			})
		)

		const pasted = pasteClipboard(DESTINATION)

		copyToClipboard([DOCS])
		settle({ succeeded: [], failed: [{ item: PHOTOS, error: new Error("no") }] })
		await pasted

		expect(entry()).toEqual({ mode: "copy", items: [DOCS] })
	})

	it("does nothing with an empty clipboard", async () => {
		await pasteClipboard(DESTINATION)

		expect(startCopyWithCard).not.toHaveBeenCalled()
		expect(performMove).not.toHaveBeenCalled()
	})
})
