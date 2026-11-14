import { describe, expect, it, vi } from "vitest"
import type { File as SdkFile } from "@filen/sdk-rs"
import { checkRemoteHead } from "@/features/pdf/save/remoteChange"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { testUuid } from "@/tests/support/uuid"

const LINEAGE = testUuid("lineage")

function sdkFile(uuid: string, stableUUID: string | undefined): SdkFile {
	return {
		uuid: testUuid(uuid),
		stableUUID: stableUUID === undefined ? undefined : testUuid(stableUUID),
		parent: testUuid("parent"),
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: {
			type: "decoded",
			data: { name: "report.pdf", mime: "application/pdf", modified: 1_700_000_000_000n, size: 1_024n, key: "k", version: 2 }
		}
	}
}

function item(uuid: string, stableUUID: string | undefined): DriveItem {
	return narrowItem(sdkFile(uuid, stableUUID))
}

describe("checkRemoteHead", () => {
	it("is current when the lineage's head is the version the edits were made on", async () => {
		const getFileByStableUuid = vi.fn(() => Promise.resolve(sdkFile("v1", "lineage")))

		await expect(checkRemoteHead(item("v1", "lineage"), { getFileByStableUuid })).resolves.toEqual({ kind: "current" })
		expect(getFileByStableUuid).toHaveBeenCalledWith(LINEAGE)
	})

	it("is changed, naming the newer version, when another one was saved meanwhile", async () => {
		const getFileByStableUuid = vi.fn(() => Promise.resolve(sdkFile("v2", "lineage")))

		await expect(checkRemoteHead(item("v1", "lineage"), { getFileByStableUuid })).resolves.toEqual({
			kind: "changed",
			currentUuid: testUuid("v2")
		})
	})

	it("is changed with no current uuid when the file is gone", async () => {
		const getFileByStableUuid = vi.fn(() => Promise.resolve(undefined))

		await expect(checkRemoteHead(item("v1", "lineage"), { getFileByStableUuid })).resolves.toEqual({
			kind: "changed",
			currentUuid: null
		})
	})

	it("is current, with no lookup, for a file without a lineage id", async () => {
		const getFileByStableUuid = vi.fn(() => Promise.resolve(undefined))

		await expect(checkRemoteHead(item("v1", undefined), { getFileByStableUuid })).resolves.toEqual({ kind: "current" })
		expect(getFileByStableUuid).not.toHaveBeenCalled()
	})

	it("rejects when the lookup fails", async () => {
		const getFileByStableUuid = vi.fn(() => Promise.reject(new Error("offline")))

		await expect(checkRemoteHead(item("v1", "lineage"), { getFileByStableUuid })).rejects.toThrow("offline")
	})
})
