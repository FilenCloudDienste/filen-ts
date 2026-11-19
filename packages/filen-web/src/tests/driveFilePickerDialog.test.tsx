// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { Dir, File as SdkFile, UuidStr } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { mockViewportHeight } from "@/tests/support/viewport"

// Picking one file from the drive: rows the caller does not accept are left out, undecryptable ones disabled,
// directories descend, a pick gets a signal that aborts when the dialog closes first.

const picker = vi.hoisted(() => ({ items: [] as DriveItem[], descend: vi.fn() }))

vi.mock("@/features/drive/hooks/useDirectoryPicker", () => ({
	useDirectoryPicker: () => ({
		pathStack: [],
		targetUuid: null,
		listingQuery: { status: "success", data: picker.items },
		items: picker.items,
		namesQuery: { data: undefined },
		descend: picker.descend,
		goRoot: vi.fn(),
		goTo: vi.fn()
	})
}))

const { DriveFilePickerDialog } = await import("@/features/drive/components/driveFilePickerDialog")

function file(name: string, undecryptable = false): DriveItem {
	const item = narrowItem({
		uuid: `${name}-0000-0000-0000-000000000000` as UuidStr,
		stableUUID: undefined,
		parent: "parent-0000-0000-0000-000000000000" as UuidStr,
		size: 1n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name, mime: "image/png", modified: 0n, size: 1n, key: "key", version: 2 } }
	} satisfies SdkFile)

	return undecryptable ? ({ ...item, data: { ...item.data, undecryptable: true } } as DriveItem) : item
}

function dir(name: string): DriveItem {
	return narrowItem({
		uuid: `${name}-0000-0000-0000-000000000000` as UuidStr,
		parent: "parent-0000-0000-0000-000000000000" as UuidStr,
		color: "default",
		timestamp: 0n,
		favorited: false,
		meta: { type: "decoded", data: { name } }
	} satisfies Dir)
}

// The picker's scroll box (the only overflow-y-auto element here) gets a height: nothing is laid out otherwise, and the
// windowed list shows no rows.
function layOutPicker(): void {
	mockViewportHeight(element => element.classList.contains("overflow-y-auto"), 400)
}

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})

describe("DriveFilePickerDialog", () => {
	it("lists accepted files and every directory, undecryptable rows disabled", () => {
		layOutPicker()
		picker.items = [dir("Photos"), file("a.png"), file("notes.txt"), file("broken.png", true)]

		render(
			<DriveFilePickerDialog
				title="Pick"
				description="Pick one"
				accept={item => item.type !== "directory" && !item.data.uuid.startsWith("notes")}
				onPick={vi.fn(() => Promise.resolve())}
				onClose={vi.fn()}
			/>
		)

		expect(screen.getByRole("button", { name: "Photos" })).toBeTruthy()
		expect(screen.getByRole("button", { name: "a.png" })).toBeTruthy()
		expect(screen.queryByRole("button", { name: "notes.txt" })).toBeNull()
		expect(screen.getByRole<HTMLButtonElement>("button", { name: "broken.png" }).disabled).toBe(true)

		fireEvent.click(screen.getByRole("button", { name: "Photos" }))
		expect(picker.descend).toHaveBeenCalledWith(picker.items[0]?.data.uuid)
	})

	it("aborts a pick under way when the dialog closes, and disables the rows meanwhile", async () => {
		layOutPicker()
		picker.items = [file("a.png"), file("b.png")]

		let signal: AbortSignal | undefined
		const onPick = vi.fn((_item: DriveItem, given: AbortSignal) => {
			signal = given

			return new Promise<void>(() => undefined)
		})
		const onClose = vi.fn()

		render(
			<DriveFilePickerDialog
				title="Pick"
				description="Pick one"
				onPick={onPick}
				onClose={onClose}
			/>
		)

		fireEvent.click(screen.getByRole("button", { name: "a.png" }))
		expect(onPick).toHaveBeenCalledWith(picker.items[0], expect.any(AbortSignal))
		expect(screen.getByRole<HTMLButtonElement>("button", { name: "b.png" }).disabled).toBe(true)
		expect(signal?.aborted).toBe(false)

		await act(async () => {
			fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
			await Promise.resolve()
		})

		expect(onClose).toHaveBeenCalled()
		expect(signal?.aborted).toBe(true)
	})

	it("mounts only a window of a directory of 10 000 files, and a row in it still picks", () => {
		layOutPicker()
		picker.items = Array.from({ length: 10_000 }, (_, index) => file(`f${String(index).padStart(5, "0")}.png`))

		const onPick = vi.fn(() => Promise.resolve())

		render(
			<DriveFilePickerDialog
				title="Pick"
				description="Pick one"
				onPick={onPick}
				onClose={vi.fn()}
			/>
		)

		const rows = screen.getAllByRole("listitem")

		expect(rows.length).toBeGreaterThan(0)
		expect(rows.length).toBeLessThan(50)
		expect(screen.queryByRole("button", { name: "f09999.png" })).toBeNull()

		fireEvent.click(screen.getByRole("button", { name: "f00003.png" }))
		expect(onPick).toHaveBeenCalledWith(picker.items[3], expect.any(AbortSignal))
	})
})
