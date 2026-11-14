import { beforeEach, describe, expect, it, vi } from "vitest"
import type { File as SdkFile } from "@filen/sdk-rs"
import { testUuid } from "@/tests/support/uuid"

const ROOT_UUID = testUuid("root")
const PARENT_UUID = testUuid("parent")

const { sdk, takenNames, patchListing, warmUploadThumbnail } = vi.hoisted(() => ({
	sdk: {
		uploadFileFromPort: vi.fn(),
		uploadFileFromBlob: vi.fn(),
		uploadFileBytes: vi.fn(),
		rewriteJpegOrientation: vi.fn()
	},
	takenNames: vi.fn<(parent: string | null) => Promise<ReadonlySet<string>>>(),
	patchListing: vi.fn(),
	warmUploadThumbnail: vi.fn()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: sdk }))
vi.mock("@/features/preview/imageEdit/editSession", () => ({ takenNames }))
vi.mock("@/features/drive/lib/actions", () => ({ currentRootUuid: () => ROOT_UUID }))
vi.mock("@/features/drive/lib/thumbGenerators", () => ({ warmUploadThumbnail }))
vi.mock("@/features/drive/lib/quota", () => ({
	checkUploadQuota: () => Promise.resolve({ status: "fits" }),
	quotaExceededMessage: () => "exceeds"
}))
vi.mock("@/features/drive/queries/drive", () => ({
	driveListingQueryUpdate: patchListing,
	normalizeParentUuid: (parent: string, root: string) => (parent === root ? null : parent)
}))

import { writeEditedCopy } from "@/features/preview/lib/editedCopy"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"

function sdkFile(name: string, uuid: string): SdkFile {
	return {
		uuid: testUuid(uuid),
		stableUUID: undefined,
		parent: PARENT_UUID,
		size: 2_048n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: {
			type: "decoded",
			data: {
				name,
				mime: "application/pdf",
				modified: 1_700_000_000_000n,
				created: 1_600_000_000_000n,
				size: 2_048n,
				key: "k",
				version: 2
			}
		}
	}
}

function item(): DriveItem {
	return narrowItem(sdkFile("report.pdf", "original"))
}

function suffix(number: number): string {
	return number <= 1 ? "edited" : `edited ${String(number)}`
}

beforeEach(() => {
	vi.clearAllMocks()
	takenNames.mockResolvedValue(new Set(["report (edited).pdf"]))
})

describe("writeEditedCopy", () => {
	it("streams a port source with its exact size under the first free name", async () => {
		sdk.uploadFileFromPort.mockResolvedValue(sdkFile("report (edited 2).pdf", "copy"))
		const { port1, port2 } = new MessageChannel()

		const written = await writeEditedCopy(item(), { port: port1, size: 2_048 }, "pdf", suffix)

		expect(written?.name).toBe("report (edited 2).pdf")
		expect(written?.outcome.status).toBe("success")
		expect(takenNames).toHaveBeenCalledWith(PARENT_UUID)
		expect(sdk.uploadFileFromPort).toHaveBeenCalledTimes(1)
		const [parent, name, mime, port, options] = sdk.uploadFileFromPort.mock.calls[0] as [
			string | null,
			string,
			string,
			MessagePort,
			{ size?: number; created?: bigint; noExifOverride?: boolean }
		]
		expect([parent, name, mime, port]).toEqual([PARENT_UUID, "report (edited 2).pdf", "", port1])
		expect(options.size).toBe(2_048)
		expect(options.created).toBe(1_600_000_000_000n)
		expect(options.noExifOverride).toBe(true)
		expect(sdk.uploadFileFromBlob).not.toHaveBeenCalled()
		expect(warmUploadThumbnail).not.toHaveBeenCalled()
		expect(patchListing).toHaveBeenCalledTimes(1)
		port2.close()
	})

	it("uploads a Blob source by reference and warms its thumbnail", async () => {
		sdk.uploadFileFromBlob.mockResolvedValue(sdkFile("report (edited 2).jpg", "copy"))
		takenNames.mockResolvedValue(new Set(["report (edited).jpg"]))
		const blob = new Blob(["jpeg"], { type: "image/jpeg" })

		const written = await writeEditedCopy(item(), { blob }, "jpg", suffix)

		expect(written?.name).toBe("report (edited 2).jpg")
		expect(sdk.uploadFileFromBlob).toHaveBeenCalledWith(PARENT_UUID, blob, "report (edited 2).jpg", "", expect.any(Object))
		expect(sdk.uploadFileFromPort).not.toHaveBeenCalled()
		expect(warmUploadThumbnail).toHaveBeenCalledTimes(1)
	})

	it("tells the writer of a port whose names cannot be read that nothing comes, so it never blocks", async () => {
		takenNames.mockRejectedValue(new Error("offline"))
		const { port1, port2 } = new MessageChannel()
		const close = vi.spyOn(port1, "close")
		// Closing a port tells its other end nothing: the save port's abort does.
		const told = new Promise<unknown>(resolve => {
			port2.addEventListener("message", (event: MessageEvent<Record<string, unknown>>) => {
				if (event.data["filen.savePort"] === "abort") resolve(event.data)
			})
			port2.start()
		})

		await expect(writeEditedCopy(item(), { port: port1, size: 10 }, "pdf", suffix)).rejects.toThrow("offline")
		expect(await told).toMatchObject({ "filen.savePort": "abort", reason: "cancelled" })
		// Acknowledged, the aborting end closes.
		port2.postMessage({ "filen.savePort": "closed" })
		await vi.waitFor(() => {
			expect(close).toHaveBeenCalledTimes(1)
		})
		expect(sdk.uploadFileFromPort).not.toHaveBeenCalled()
	})
})
