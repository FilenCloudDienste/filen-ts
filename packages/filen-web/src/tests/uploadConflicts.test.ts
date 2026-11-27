import { beforeEach, describe, expect, it, vi } from "vitest"
import { onlineManager } from "@tanstack/react-query"
import type { File as SdkFile, NormalDirsAndFiles, UuidStr } from "@filen/sdk-rs"
import type { ConflictAnswer, NameConflict } from "@/features/drive/lib/nameConflicts"

// startUploads' conflict check against the real listing query, claims and naming, with the sdk client, the
// query client and the prompt mocked down.
const { uploadFile, listDirectory, ask } = vi.hoisted(() => ({
	uploadFile: vi.fn<(parentUuid: string | null, transferId: string, file: File, runId?: string) => Promise<SdkFile>>(),
	listDirectory: vi.fn<(target: unknown) => Promise<NormalDirsAndFiles>>(),
	ask: vi.fn<(args: { conflicts: readonly NameConflict[] }) => Promise<ConflictAnswer | null>>()
}))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: { uploadFile, listDirectory, cancelTransfer: vi.fn(), getUserInfo: vi.fn(), setProgressSink: vi.fn() }
}))
vi.mock("@/queries/client", async () => ({ queryClient: (await import("@/tests/testQueryClient")).createTestQueryClient() }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@/features/transfers/lib/transferStartToast", () => ({ toastTransferStarted: vi.fn() }))
vi.mock("@/features/drive/lib/nameConflictAsk", () => ({ askNameConflicts: ask }))
vi.mock("@/features/drive/lib/heicUpload", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/lib/heicUpload")>()),
	heicUploadConversionEnabled: () => Promise.resolve(false)
}))

import { startUploads } from "@/features/drive/lib/upload"
import { discardUploadClaims } from "@/features/drive/lib/uploadClaims"
import { useTransfersStore } from "@/features/transfers/store/useTransfersStore"
import { queryClient } from "@/queries/client"
import { ACCOUNT_QUERY_KEY } from "@/queries/account"
import { discardListingPatches } from "@/features/drive/queries/drive"
import { socketAuthenticated } from "@/lib/sdk/socketSession"
import { testUuid } from "@/tests/support/uuid"

function sdkFile(name: string, parent: UuidStr): SdkFile {
	return {
		uuid: testUuid(`file-${name}-${parent}`),
		stableUUID: undefined,
		parent,
		size: 4n,
		favorited: false,
		region: "",
		bucket: "",
		timestamp: 1n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name, mime: "text/plain", modified: 1n, size: 4n, key: "k", version: 2 } }
	}
}

function browserFile(name: string): File {
	return new File([new Uint8Array(4)], name)
}

let dirCounter = 0

function nextDir(): UuidStr {
	dirCounter++

	return testUuid(`upload-conflict${String(dirCounter)}`)
}

function uploadedNames(): string[] {
	return uploadFile.mock.calls.map(([, , file]) => file.name).sort()
}

beforeEach(() => {
	vi.clearAllMocks()
	queryClient.clear()
	discardListingPatches()
	discardUploadClaims()
	socketAuthenticated()
	onlineManager.setOnline(true)
	useTransfersStore.setState({ transfers: [] })
	queryClient.setQueryData(ACCOUNT_QUERY_KEY, { storageUsed: 0n, maxStorage: 1n << 40n })
	uploadFile.mockImplementation((parent, _id, file) => Promise.resolve(sdkFile(file.name, (parent ?? testUuid("root")) as UuidStr)))
})

describe("startUploads name conflicts", () => {
	it("starts clean files before the prompt is answered, then uploads the answered ones under their names", async () => {
		const dir = nextDir()
		let answer: (value: ConflictAnswer) => void = () => undefined

		listDirectory.mockResolvedValue({ dirs: [], files: [sdkFile("a.txt", dir), sdkFile("B.TXT", dir)] })
		ask.mockReturnValue(
			new Promise(resolve => {
				answer = resolve
			})
		)

		const done = startUploads([browserFile("a.txt"), browserFile("b.txt"), browserFile("c.txt")], dir)

		await vi.waitFor(() => {
			expect(uploadedNames()).toEqual(["c.txt"])
		})
		expect(ask.mock.calls[0]?.[0].conflicts.map(conflict => conflict.name)).toEqual(["a.txt", "b.txt"])

		answer({ choices: ["keepBoth", "skip"], nested: "replace" })
		await done

		expect(uploadedNames()).toEqual(["a (1).txt", "c.txt"])
		expect(listDirectory).toHaveBeenCalledTimes(1)
	})

	it("replaces with the picked name, which makes the new version", async () => {
		const dir = nextDir()

		listDirectory.mockResolvedValue({ dirs: [], files: [sdkFile("a.txt", dir)] })
		ask.mockResolvedValue({ choices: ["replace"], nested: "replace" })

		await startUploads([browserFile("a.txt")], dir)

		expect(uploadedNames()).toEqual(["a.txt"])
	})

	it("sees a name another upload into the directory is still sending", async () => {
		const dir = nextDir()
		let finish: (file: SdkFile) => void = () => undefined

		listDirectory.mockResolvedValue({ dirs: [], files: [] })
		uploadFile.mockReturnValueOnce(
			new Promise(resolve => {
				finish = resolve
			})
		)
		ask.mockResolvedValue({ choices: ["keepBoth"], nested: "replace" })

		const first = startUploads([browserFile("a.txt")], dir)

		await vi.waitFor(() => {
			expect(uploadFile).toHaveBeenCalledTimes(1)
		})
		await startUploads([browserFile("A.txt")], dir)

		expect(ask).toHaveBeenCalledOnce()
		expect(uploadedNames()).toEqual(["A (1).txt", "a.txt"])

		finish(sdkFile("a.txt", dir))
		await first
	})

	it("uploads everything as picked, asking nothing, when offline with no listing held", async () => {
		onlineManager.setOnline(false)

		await startUploads([browserFile("a.txt")], nextDir())

		expect(listDirectory).not.toHaveBeenCalled()
		expect(ask).not.toHaveBeenCalled()
		expect(uploadedNames()).toEqual(["a.txt"])
	})
})
