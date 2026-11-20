import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Dir, UuidStr } from "@filen/sdk-rs"

const { performMove, startCopyWithCard, toastSuccess } = vi.hoisted(() => ({
	performMove: vi.fn(),
	startCopyWithCard: vi.fn(),
	toastSuccess: vi.fn()
}))

// Copying looks its items up in the cached listings, which hold none here.
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("@/features/drive/lib/dnd", () => ({ performMove }))
vi.mock("@/features/transfers/lib/copyToast", () => ({ startCopyWithCard }))
vi.mock("sonner", () => ({ toast: { success: toastSuccess } }))

import "@/lib/i18n"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { copyToClipboard, cutToClipboard, pasteClipboard, systemClipboardOutdated } from "@/features/drive/lib/clipboard"
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

afterEach(() => {
	vi.unstubAllGlobals()
})

function stubSystemClipboard(writeText: (text: string) => Promise<void>): void {
	vi.stubGlobal("navigator", { clipboard: { writeText } })
}

describe("the system clipboard", () => {
	it("takes the names of what was copied or cut, so the drive clipboard is the latest copy", async () => {
		const writeText = vi.fn(() => Promise.resolve())

		stubSystemClipboard(writeText)
		copyToClipboard([DOCS, PHOTOS])

		expect(writeText).toHaveBeenCalledExactlyOnceWith("docs\nphotos")
		// Until the write lands, what it held before is older than the entry.
		expect(systemClipboardOutdated()).toBe(true)
		await vi.waitFor(() => {
			expect(systemClipboardOutdated()).toBe(false)
		})

		cutToClipboard([DOCS])
		expect(writeText).toHaveBeenLastCalledWith("docs")
	})

	it("counts as outdated while the drive clipboard holds an entry whose names it refused", async () => {
		stubSystemClipboard(() => Promise.reject(new DOMException("denied", "NotAllowedError")))
		copyToClipboard([DOCS])

		await new Promise(resolve => setTimeout(resolve, 0))
		expect(systemClipboardOutdated()).toBe(true)

		useDriveClipboardStore.getState().clear()
		expect(systemClipboardOutdated()).toBe(false)
	})

	it("counts as outdated without a clipboard API, and copying still works", () => {
		vi.stubGlobal("navigator", {})
		copyToClipboard([DOCS])

		expect(entry()).toEqual({ mode: "copy", items: [DOCS] })
		expect(systemClipboardOutdated()).toBe(true)
	})

	it("is not outdated by an earlier write that lands after a later copy was refused", async () => {
		let land: () => void = () => undefined
		stubSystemClipboard(
			() =>
				new Promise<void>(resolve => {
					land = resolve
				})
		)
		copyToClipboard([DOCS])
		const first = land

		stubSystemClipboard(() => Promise.reject(new Error("denied")))
		copyToClipboard([PHOTOS])
		first()

		await new Promise(resolve => setTimeout(resolve, 0))
		expect(systemClipboardOutdated()).toBe(true)
	})
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

		expect(performMove).toHaveBeenCalledExactlyOnceWith([DOCS, PHOTOS], DESTINATION, true)
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

	it("names the cut items for dimming, and nothing for a copy", () => {
		cutToClipboard([DOCS])

		expect([...useDriveClipboardStore.getState().cutUuids]).toEqual([DOCS.data.uuid])

		copyToClipboard([DOCS])

		expect(useDriveClipboardStore.getState().cutUuids.size).toBe(0)
	})

	it("does nothing with an empty clipboard", async () => {
		await pasteClipboard(DESTINATION)

		expect(startCopyWithCard).not.toHaveBeenCalled()
		expect(performMove).not.toHaveBeenCalled()
	})
})
