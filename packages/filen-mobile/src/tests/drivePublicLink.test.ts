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

// What each status-cache write set the status to.
function statusUpdates(): unknown[] {
	return mockStatusQueryUpdate.mock.calls.map(call => (call[0] as { updater: () => unknown }).updater())
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

	it("a link already disabled elsewhere: nothing to remove, but the caches stop showing it", async () => {
		sdk.getFileLinkStatus.mockResolvedValue(undefined)

		await disablePublicLink({ item: file })

		expect(sdk.removeFileLink).not.toHaveBeenCalled()
		expect(statusUpdates()).toEqual([null])
		expect(mockDriveItemsQueryUpdate).toHaveBeenCalledTimes(1)
	})
})

describe("updatePublicLink", () => {
	it("a directory save writes the edits onto the held link with no status read", async () => {
		await updatePublicLink({ item: dir, held: { type: "directory", status: dirLink }, edits: { downloadable: false } })

		const written = { ...dirLink, enableDownload: false }

		expect(statusCalls()).toBe(0)
		expect(sdk.updateDirLink).toHaveBeenCalledWith(dir.data, written, undefined)
		expect(statusUpdates()).toEqual([{ type: "directory", status: written }])
	})

	it("a file save reads the status once and writes the edits onto it", async () => {
		const outcome = await updatePublicLink({ item: file, held: { type: "file", status: fileLink }, edits: { downloadable: false } })

		const written = { ...fileLink, downloadable: false }

		expect(outcome).toBe("updated")
		expect(sdk.getFileLinkStatus).toHaveBeenCalledTimes(1)
		expect(sdk.updateFileLink).toHaveBeenCalledWith(file.data, written, undefined)
		expect(statusUpdates()).toEqual([{ type: "file", status: written }])
	})

	it("a file link disabled elsewhere is not re-published: no write, the status becomes none", async () => {
		sdk.getFileLinkStatus.mockResolvedValue(undefined)

		const outcome = await updatePublicLink({ item: file, held: { type: "file", status: fileLink }, edits: { downloadable: false } })

		expect(outcome).toBe("gone")
		expect(sdk.updateFileLink).not.toHaveBeenCalled()
		expect(statusUpdates()).toEqual([null])
		expect(mockDriveItemsQueryUpdate).toHaveBeenCalledTimes(1)
	})

	it("a file link replaced elsewhere is not written: the status becomes the new link", async () => {
		const replacement = { ...fileLink, linkUuid: "l-file-2" } as FilePublicLink

		sdk.getFileLinkStatus.mockResolvedValue(replacement)

		const outcome = await updatePublicLink({ item: file, held: { type: "file", status: fileLink }, edits: { downloadable: false } })

		expect(outcome).toBe("replaced")
		expect(sdk.updateFileLink).not.toHaveBeenCalled()
		expect(statusUpdates()).toEqual([{ type: "file", status: replacement }])
	})

	it("fields changed elsewhere since the held read are kept: only the edited ones are written", async () => {
		const changedElsewhere = { ...fileLink, expiration: "one_day", salt: "salt-2" } as unknown as FilePublicLink

		sdk.getFileLinkStatus.mockResolvedValue(changedElsewhere)

		await updatePublicLink({ item: file, held: { type: "file", status: fileLink }, edits: { downloadable: false } })

		expect(sdk.updateFileLink).toHaveBeenCalledWith(file.data, { ...changedElsewhere, downloadable: false }, undefined)
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

	it("an existing link (made elsewhere since the screen's read) is cached, so the screen shows it", async () => {
		await enablePublicLink({ item: dir })
		await enablePublicLink({ item: file })

		expect(sdk.publicLinkDir).not.toHaveBeenCalled()
		expect(sdk.publicLinkFile).not.toHaveBeenCalled()
		expect(statusUpdates()).toEqual([
			{ type: "directory", status: dirLink },
			{ type: "file", status: fileLink }
		])
	})
})
