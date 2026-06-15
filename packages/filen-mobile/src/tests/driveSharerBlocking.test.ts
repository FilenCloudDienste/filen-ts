import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/cache", () => ({
	default: {
		directoryUuidToAnySharedDirWithContext: {
			get: (uuid: string) =>
				uuid === "dir-cache" ? { dir: {}, shareInfo: { tag: "Receiver", inner: [{ id: 77n, email: "cache@x.com" }] } } : undefined
		}
	}
}))

import { getSharerIdentity } from "@/features/drive/driveSharer"
import { type DriveItem } from "@/types"

const role = (id: bigint, email: string) => ({ tag: "Receiver", inner: [{ id, email }] }) as never

describe("getSharerIdentity", () => {
	it("reads sharingRole on a shared root file", () => {
		const item = { type: "sharedRootFile", data: { uuid: "f", sharingRole: role(10n, "a@x.com") } } as unknown as DriveItem

		expect(getSharerIdentity(item)).toEqual({ userId: 10n, email: "a@x.com" })
	})

	it("reads sharingRole on a non-root shared dir when present", () => {
		const item = { type: "sharedDirectory", data: { uuid: "d", sharingRole: role(20n, "b@x.com") } } as unknown as DriveItem

		expect(getSharerIdentity(item)).toEqual({ userId: 20n, email: "b@x.com" })
	})

	it("falls back to the shared-dir cache for a non-root dir without sharingRole", () => {
		const item = { type: "sharedDirectory", data: { uuid: "dir-cache" } } as unknown as DriveItem

		expect(getSharerIdentity(item)).toEqual({ userId: 77n, email: "cache@x.com" })
	})

	it("returns null for a normal file", () => {
		const item = { type: "file", data: { uuid: "n" } } as unknown as DriveItem

		expect(getSharerIdentity(item)).toBeNull()
	})
})
