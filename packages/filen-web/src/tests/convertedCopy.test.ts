import { beforeEach, describe, expect, it, vi } from "vitest"
import type { File, NormalDirsAndFiles, UuidStr } from "@filen/sdk-rs"
import { convertedCopyName } from "@/features/drive/lib/copyName"

const { listDirectory, nameExistsInDirectory, uploadFileBytes } = vi.hoisted(() => ({
	listDirectory: vi.fn<(target: unknown) => Promise<NormalDirsAndFiles>>(),
	nameExistsInDirectory: vi.fn<(parent: string | null, name: string) => Promise<boolean>>(),
	uploadFileBytes: vi.fn<(parent: string | null, data: Uint8Array, name: string, mime: string) => Promise<File>>()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { listDirectory, nameExistsInDirectory, uploadFileBytes } }))
vi.mock("@/queries/client", async () => ({ queryClient: (await import("@/tests/testQueryClient")).createTestQueryClient() }))
vi.mock("@/features/drive/lib/actions", () => ({ currentRootUuid: () => "root" }))
vi.mock("@/features/drive/lib/quota", () => ({
	checkUploadQuota: () => Promise.resolve({ status: "fits" }),
	quotaExceededMessage: () => ""
}))

import { queryClient } from "@/queries/client"
import { discardListingPatches, driveListingQueryOptions } from "@/features/drive/queries/drive"
import { uploadConvertedCopy } from "@/features/drive/lib/convertedCopy"
import { narrowItem } from "@/features/drive/lib/item"
import { socketAuthenticated } from "@/lib/sdk/socketSession"
import { testUuid } from "@/tests/support/uuid"

function mockFile(name: string, parent: UuidStr): File {
	return {
		uuid: testUuid(`converted-${name}`),
		stableUUID: undefined,
		parent,
		size: 3n,
		favorited: false,
		region: "",
		bucket: "",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name, mime: "application/msword", modified: 1n, size: 3n, key: "k", version: 2 } }
	}
}

describe("convertedCopyName", () => {
	it("takes the file's name with the new extension", async () => {
		expect(await convertedCopyName("report.doc", "docx", () => Promise.resolve(false))).toBe("report.docx")
		expect(await convertedCopyName("Template.DOT", "docx", () => Promise.resolve(false))).toBe("Template.docx")
		expect(await convertedCopyName("noextension", "docx", () => Promise.resolve(false))).toBe("noextension.docx")
	})

	it("counts on past taken names, never reusing one", async () => {
		const taken = new Set(["report.docx", "report (2).docx"])

		expect(await convertedCopyName("report.doc", "docx", name => Promise.resolve(taken.has(name)))).toBe("report (3).docx")
	})
})

describe("uploadConvertedCopy", () => {
	const parent = testUuid("converted-parent")

	beforeEach(() => {
		queryClient.clear()
		discardListingPatches()
		socketAuthenticated()
		listDirectory.mockReset()
		nameExistsInDirectory.mockReset()
		uploadFileBytes.mockReset()
		uploadFileBytes.mockImplementation((_parent, _data, name) => Promise.resolve(mockFile(name, parent)))
	})

	it("answers every candidate from the directory's current cached listing, without a name lookup", async () => {
		const source = mockFile("report.doc", parent)

		listDirectory.mockResolvedValue({
			dirs: [],
			files: [source, mockFile("Report.DOCX", parent), mockFile("report (2).docx", parent), mockFile("report (3).docx", parent)]
		})
		await queryClient.query(driveListingQueryOptions("drive", parent))

		const outcome = await uploadConvertedCopy(narrowItem(source), new Uint8Array(3), "docx")

		expect(outcome).toMatchObject({ status: "saved", name: "report (4).docx" })
		expect(listDirectory).toHaveBeenCalledOnce()
		expect(nameExistsInDirectory).not.toHaveBeenCalled()
		expect(uploadFileBytes).toHaveBeenCalledOnce()
	})

	it("answers an error outcome when the directory's names cannot be read, uploading nothing", async () => {
		listDirectory.mockRejectedValue(new Error("parent gone"))

		const outcome = await uploadConvertedCopy(narrowItem(mockFile("report.doc", parent)), new Uint8Array(3), "docx")

		expect(outcome.status).toBe("error")
		expect(outcome.status === "error" ? outcome.dto : null).not.toBeNull()
		expect(uploadFileBytes).not.toHaveBeenCalled()
	})
})
