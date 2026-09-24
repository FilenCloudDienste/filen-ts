import { vi, describe, it, expect, beforeEach } from "vitest"

const { sdk, mockDriveItemsQueryUpdate, mockStatusQueryUpdate } = vi.hoisted(() => ({
	sdk: {
		getDirLinkStatus: vi.fn(),
		getFileLinkStatus: vi.fn(),
		removeDirLink: vi.fn(),
		removeFileLink: vi.fn(),
		updateDirLink: vi.fn(),
		updateFileLink: vi.fn(),
		publicLinkDir: vi.fn(),
		publicLinkFile: vi.fn()
	},
	mockDriveItemsQueryUpdate: vi.fn(),
	mockStatusQueryUpdate: vi.fn()
}))

vi.mock("@/lib/auth", () => ({
	default: {
		getSdkClients: async () => ({ authedSdkClient: sdk })
	}
}))

vi.mock("@/features/drive/queries/useDriveItems.query", () => ({
	driveItemsQueryUpdate: mockDriveItemsQueryUpdate
}))

vi.mock("@/features/drive/queries/useDriveItemPublicLinkStatus.query", () => ({
	driveItemPublicLinkStatusQueryUpdate: mockStatusQueryUpdate
}))

import { enablePublicLink, disablePublicLink, updatePublicLink } from "@/features/drive/drivePublicLink"
import type { DirPublicLinkRw, FilePublicLink } from "@filen/sdk-rs"
import type { DriveItem } from "@/types"

const dir = { type: "directory", data: { uuid: "dir-1" } } as unknown as DriveItem
const file = { type: "file", data: { uuid: "file-1" } } as unknown as DriveItem
const dirLink = { linkUuid: "l-dir", password: undefined, enableDownload: true, expiration: "never" } as unknown as DirPublicLinkRw
const fileLink = { linkUuid: "l-file", password: undefined, downloadable: true, expiration: "never" } as unknown as FilePublicLink

function statusCalls(): number {
	return sdk.getDirLinkStatus.mock.calls.length + sdk.getFileLinkStatus.mock.calls.length
}

beforeEach(() => {
	for (const fn of Object.values(sdk)) {
		fn.mockReset()
	}

	sdk.getDirLinkStatus.mockResolvedValue(dirLink)
	sdk.getFileLinkStatus.mockResolvedValue(fileLink)
	sdk.publicLinkDir.mockResolvedValue(dirLink)
	sdk.publicLinkFile.mockResolvedValue(fileLink)
	mockDriveItemsQueryUpdate.mockReset()
	mockStatusQueryUpdate.mockReset()
})

describe("disablePublicLink", () => {
	it("with the screen's status: no status read, the directory is unlinked", async () => {
		await disablePublicLink({ item: dir, known: { type: "directory", status: dirLink } })

		expect(statusCalls()).toBe(0)
		expect(sdk.removeDirLink).toHaveBeenCalledTimes(1)
	})

	it("with the screen's status: no status read, and removeFileLink gets that status", async () => {
		await disablePublicLink({ item: file, known: { type: "file", status: fileLink } })

		expect(statusCalls()).toBe(0)
		expect(sdk.removeFileLink).toHaveBeenCalledWith(file.data, fileLink, undefined)
	})

	it("without a status (context menu, bulk disable): still reads it once per item", async () => {
		await disablePublicLink({ item: dir })
		await disablePublicLink({ item: file })

		expect(sdk.getDirLinkStatus).toHaveBeenCalledTimes(1)
		expect(sdk.getFileLinkStatus).toHaveBeenCalledTimes(1)
		expect(sdk.removeFileLink).toHaveBeenCalledWith(file.data, fileLink, undefined)
	})

	it("a status of the other item type is ignored and the status is read", async () => {
		await disablePublicLink({ item: file, known: { type: "directory", status: dirLink } })

		expect(sdk.getFileLinkStatus).toHaveBeenCalledTimes(1)
	})
})

describe("updatePublicLink", () => {
	it("writes the caller's link as-is with no status read (directory)", async () => {
		const edited = { ...dirLink, enableDownload: false }

		await updatePublicLink({ item: dir, link: { type: "directory", link: edited } })

		expect(statusCalls()).toBe(0)
		expect(sdk.updateDirLink).toHaveBeenCalledWith(dir.data, edited, undefined)

		const updater = mockStatusQueryUpdate.mock.calls[0]?.[0]?.updater as () => unknown

		expect(updater()).toEqual({ type: "directory", status: edited })
	})

	it("writes the caller's link as-is with no status read (file)", async () => {
		const edited = { ...fileLink, downloadable: false }

		await updatePublicLink({ item: file, link: { type: "file", link: edited } })

		expect(statusCalls()).toBe(0)
		expect(sdk.updateFileLink).toHaveBeenCalledWith(file.data, edited, undefined)
	})
})

describe("enablePublicLink", () => {
	it("known absent (the screen's read found none): creates without a status read", async () => {
		await enablePublicLink({ item: dir, knownAbsent: true })
		await enablePublicLink({ item: file, knownAbsent: true })

		expect(statusCalls()).toBe(0)
		expect(sdk.publicLinkDir).toHaveBeenCalledTimes(1)
		expect(sdk.publicLinkFile).toHaveBeenCalledTimes(1)
	})

	it("otherwise (chats) checks first and returns an existing link without creating one", async () => {
		const result = await enablePublicLink({ item: file })

		expect(sdk.getFileLinkStatus).toHaveBeenCalledTimes(1)
		expect(sdk.publicLinkFile).not.toHaveBeenCalled()
		expect(result).toEqual({ type: "file", link: fileLink })
	})
})
