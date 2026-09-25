// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import type { Dir, SharedDir, SharingRole, UuidStr } from "@filen/sdk-rs"
import "@/lib/i18n"

const { uploadDroppedFiles } = vi.hoisted(() => ({ uploadDroppedFiles: vi.fn() }))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/features/drive/hooks/useThumbnail", () => ({ useThumbnail: () => null }))
vi.mock("@/features/drive/lib/uploadDrop", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/lib/uploadDrop")>()),
	uploadDroppedFiles
}))

import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { DriveRow } from "@/features/drive/components/driveRow"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

const OWNED = narrowItem({
	uuid: testUuid("owned"),
	parent: testUuid("parent"),
	color: "default",
	timestamp: 0n,
	favorited: false,
	meta: { type: "decoded", data: { name: "owned" } }
} satisfies Dir)

// A directory below one the user shared out: theirs, listed under Shared by me.
const SHARED_DIR: SharedDir & { sharingRole: SharingRole } = {
	inner: {
		uuid: testUuid("shared"),
		parent: testUuid("parent"),
		color: "default",
		timestamp: 0n,
		favorited: false,
		meta: { type: "decoded", data: { name: "shared" } }
	},
	sharedTag: true,
	sharingRole: { Receiver: { email: "friend@filen.io", id: 7 } }
}
const SHARED_OUT = narrowItem(SHARED_DIR)

function renderRow(item: DriveItem, variant: DriveVariant) {
	render(
		createElement(DriveRow, {
			item,
			index: 0,
			total: 1,
			selected: false,
			active: false,
			variant,
			style: {},
			splat: testUuid("parent"),
			directorySizes: new Map(),
			selectedItems: [],
			onPointerSelect: () => undefined,
			onCursorMove: () => undefined,
			onOpen: () => undefined,
			onItemAction: () => undefined,
			onBulkAction: () => undefined,
			registerRef: () => undefined
		})
	)

	return screen.getByRole("option")
}

// An OS file drag: the browser exposes only the "Files" type until the drop.
function fileDrag(type: "dragOver" | "drop", element: Element): Event {
	const event = createEvent[type](element, { dataTransfer: { types: ["Files"], dropEffect: "none", items: [], files: [] } })

	fireEvent(element, event)

	return event
}

afterEach(() => {
	cleanup()
})

describe("files from the system dropped on a directory row", () => {
	it.each([
		["My Drive", OWNED, "drive" as const],
		["a Shared by me directory", SHARED_OUT, "sharedOut" as const]
	])("upload into it in %s, wherever the listing's own dropzone would upload", (_label, item, variant) => {
		const row = renderRow(item, variant)

		expect(fileDrag("dragOver", row).defaultPrevented).toBe(true)
		fileDrag("drop", row)

		expect(uploadDroppedFiles).toHaveBeenCalledExactlyOnceWith(expect.anything(), item.data.uuid)
	})

	it.each(["recents", "favorites", "links", "sharedIn", "trash"] as const)("are left to the page in %s", variant => {
		const row = renderRow(OWNED, variant)

		expect(fileDrag("dragOver", row).defaultPrevented).toBe(false)
		fileDrag("drop", row)

		expect(uploadDroppedFiles).not.toHaveBeenCalled()
	})
})
