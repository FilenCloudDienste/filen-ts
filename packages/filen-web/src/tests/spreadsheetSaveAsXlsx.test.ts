import { describe, expect, it, vi } from "vitest"
import type { File as SdkFile } from "@filen/sdk-rs"
import { narrowItem } from "@/features/drive/lib/item"
import { saveAsXlsx } from "@/features/spreadsheet/lib/saveAsXlsx"

const { uploadFileBytes } = vi.hoisted(() => ({ uploadFileBytes: vi.fn() }))

vi.mock("@/features/spreadsheet/lib/spreadsheetClient", () => ({
	withSpreadsheetWorker: (run: (remote: { xlsToXlsx: (bytes: Uint8Array) => Promise<Uint8Array> }) => Promise<unknown>) =>
		run({ xlsToXlsx: bytes => Promise.resolve(bytes) })
}))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: { uploadFileBytes, nameExistsInDirectory: () => Promise.resolve(false) }
}))

vi.mock("@/features/drive/lib/actions", () => ({ currentRootUuid: () => "root-0000-0000-0000-000000000000" }))

vi.mock("@/features/drive/queries/drive", () => ({
	driveListingQueryUpdate: () => undefined,
	normalizeParentUuid: (parent: string, root: string) => (parent === root ? null : parent)
}))

function sdkFile(name: string, mime: string): SdkFile {
	return {
		uuid: `${name}-0000-0000-0000-000000000000`,
		stableUUID: undefined,
		parent: "dir-0000-0000-0000-000000000000",
		size: 4n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name, mime, modified: 1_700_000_000_000n, size: 4n, key: "key", version: 2 } }
	}
}

describe("saveAsXlsx", () => {
	it("uploads the copy without the .xls's type, for the SDK to take from the .xlsx name", async () => {
		uploadFileBytes.mockResolvedValue(sdkFile("budget.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"))

		const outcome = await saveAsXlsx(narrowItem(sdkFile("budget.xls", "application/vnd.ms-excel")), new Uint8Array([1, 2, 3, 4]))

		expect(outcome).toMatchObject({ status: "saved", name: "budget.xlsx" })
		expect(uploadFileBytes).toHaveBeenCalledWith("dir-0000-0000-0000-000000000000", expect.any(Uint8Array), "budget.xlsx", "")
	})
})
