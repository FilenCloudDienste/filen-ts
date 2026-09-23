import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { File as SdkFile, Dir, FilePublicLink, DirPublicLinkRW, UserInfo, UuidStr } from "@filen/sdk-rs"

// Mock boundary matching upload.test.ts: the real sdk client/query client modules import a Vite
// `?worker` / touch an OPFS-backed persister, unresolvable/unwanted under node vitest.
const { createDirectory, uploadFile, getFileLinkStatus, getDirectoryLinkStatus, createFileLink, createDirectoryLink, getUserInfo } =
	vi.hoisted(() => ({
		createDirectory: vi.fn<(parentUuid: string | null, name: string) => Promise<Dir>>(),
		uploadFile:
			vi.fn<(parentUuid: string | null, transferId: string, file: File, onProgress: (bytes: bigint) => void) => Promise<SdkFile>>(),
		getFileLinkStatus: vi.fn<(file: unknown) => Promise<FilePublicLink | undefined>>(),
		getDirectoryLinkStatus: vi.fn<(dir: unknown) => Promise<DirPublicLinkRW | undefined>>(),
		createFileLink: vi.fn<(file: unknown) => Promise<FilePublicLink>>(),
		createDirectoryLink: vi.fn<(dir: unknown, onProgress: unknown) => Promise<DirPublicLinkRW>>(),
		getUserInfo: vi.fn<() => Promise<UserInfo>>()
	}))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: { createDirectory, uploadFile, getFileLinkStatus, getDirectoryLinkStatus, createFileLink, createDirectoryLink, getUserInfo }
}))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))

vi.mock("sonner", () => ({ toast: { error: toastError } }))

import { uploadAttachment, attachExistingDriveItem, preflightAttachments, resetChatUploadsDirCache } from "@/features/chats/lib/attachments"
import { narrowItem } from "@/features/drive/lib/item"
import { useTransfersStore } from "@/features/transfers/store/useTransfersStore"
import { noop } from "@/lib/utils"
import { formatBytes } from "@filen/shared"
import { queryClient } from "@/queries/client"
import { ACCOUNT_QUERY_KEY } from "@/queries/account"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function mockDir(uuid: string): Dir {
	return {
		uuid: testUuid(uuid),
		parent: testUuid("root"),
		color: "default",
		timestamp: 0n,
		favorited: false,
		meta: { type: "decoded", data: { name: uuid } }
	}
}

function mockBrowserFile(name = "photo.jpg", size = 1_024): File {
	return new File([new Uint8Array(size)], name)
}

function mockSdkFile(overrides: Partial<SdkFile> = {}): SdkFile {
	return {
		uuid: testUuid("uploaded"),
		stableUUID: undefined,
		parent: testUuid("chat-uploads"),
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: {
			type: "decoded",
			data: {
				name: "photo.jpg",
				mime: "image/jpeg",
				modified: 1_700_000_000_000n,
				size: 1_024n,
				key: "the-decrypted-key",
				version: 2
			}
		},
		...overrides
	}
}

function mockFilePublicLink(overrides: Partial<FilePublicLink> = {}): FilePublicLink {
	return {
		linkUuid: testUuid("link"),
		password: { type: "none" },
		expiration: "never",
		downloadable: true,
		salt: "",
		...overrides
	}
}

function mockDirPublicLinkRW(overrides: Partial<DirPublicLinkRW> = {}): DirPublicLinkRW {
	return {
		linkUuid: testUuid("link"),
		linkKey: "the-dir-link-key",
		linkKeyVersion: 1,
		password: { type: "none" },
		expiration: "never",
		enableDownload: true,
		salt: "",
		...overrides
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	useTransfersStore.setState({ transfers: [] })
	// attachments.ts memoizes the uploads-directory uuid for the tab's lifetime, so without this the
	// directory-creation tests can only ever pass in the one order where they run before the memo is
	// warm — which is why two of them failed under shuffle.
	resetChatUploadsDirCache()
	// Room to spare: the quota pre-flight passes from the cache without a read.
	queryClient.setQueryData(ACCOUNT_QUERY_KEY, { storageUsed: 0n, maxStorage: 1n << 40n })
})

afterEach(() => {
	vi.clearAllMocks()
})

describe("preflightAttachments", () => {
	it("passes a pick that fits the cached account without an account read", async () => {
		expect(await preflightAttachments([mockBrowserFile("a.jpg", 1_024), mockBrowserFile("b.jpg", 1_024)])).toBe(true)
		expect(getUserInfo).not.toHaveBeenCalled()
		expect(toastError).not.toHaveBeenCalled()
	})

	it("checks the pick as one total: refused after exactly one fresh read, with a single message", async () => {
		// Each file alone fits; together they do not.
		queryClient.setQueryData(ACCOUNT_QUERY_KEY, { storageUsed: 1_000n, maxStorage: 2_500n })
		getUserInfo.mockResolvedValueOnce({ storageUsed: 1_000n, maxStorage: 2_500n } as UserInfo)

		expect(await preflightAttachments([mockBrowserFile("a.jpg", 1_024), mockBrowserFile("b.jpg", 1_024)])).toBe(false)
		expect(getUserInfo).toHaveBeenCalledOnce()
		expect(toastError).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(formatBytes(2_048)))
		expect(createDirectory).not.toHaveBeenCalled()
		expect(uploadFile).not.toHaveBeenCalled()
	})
})

describe("uploadAttachment", () => {
	it("returns an error outcome when the chat-uploads directory itself can't be created/found", async () => {
		createDirectory.mockRejectedValueOnce(new Error("parent directory not found"))

		const outcome = await uploadAttachment(mockBrowserFile(), noop)

		expect(outcome.status).toBe("error")
		expect(uploadFile).not.toHaveBeenCalled()
	})

	it("uploads into the idempotent .filen/Chat Uploads directory, then creates a link and returns its url", async () => {
		createDirectory.mockResolvedValueOnce(mockDir("dot-filen")).mockResolvedValueOnce(mockDir("chat-uploads"))
		const uploaded = mockSdkFile()
		uploadFile.mockResolvedValueOnce(uploaded)
		getFileLinkStatus.mockResolvedValueOnce(undefined)
		const link = mockFilePublicLink()
		createFileLink.mockResolvedValueOnce(link)

		const outcome = await uploadAttachment(mockBrowserFile(), noop)

		expect(createDirectory).toHaveBeenNthCalledWith(1, null, ".filen")
		expect(createDirectory).toHaveBeenNthCalledWith(2, testUuid("dot-filen"), "Chat Uploads")
		expect(uploadFile).toHaveBeenCalledOnce()
		expect(uploadFile.mock.calls[0]?.[0]).toBe(testUuid("chat-uploads"))
		expect(createFileLink).toHaveBeenCalledOnce()
		expect(outcome.status).toBe("success")
		expect(outcome.status === "success" && outcome.url.startsWith("https://app.filen.io/f/")).toBe(true)
		// The composer pre-flights the pick; the upload itself never reads the account, only patches it.
		expect(getUserInfo).not.toHaveBeenCalled()
		expect(queryClient.getQueryData<UserInfo>(ACCOUNT_QUERY_KEY)?.storageUsed).toBe(1_024n)
	})

	it("reuses an EXISTING link rather than creating a second one, when the just-uploaded item already has one", async () => {
		// Realistically rare for a brand-new upload, but the shared ensurePublicLinkUrl tail is get-then-
		// create regardless of caller — this proves the "get" half actually short-circuits "create".
		createDirectory.mockResolvedValueOnce(mockDir("dot-filen")).mockResolvedValueOnce(mockDir("chat-uploads"))
		uploadFile.mockResolvedValueOnce(mockSdkFile())
		getFileLinkStatus.mockResolvedValueOnce(mockFilePublicLink())

		const outcome = await uploadAttachment(mockBrowserFile(), noop)

		expect(createFileLink).not.toHaveBeenCalled()
		expect(outcome.status).toBe("success")
	})

	it("surfaces the SERVER's own error label, unaltered, when link creation is premium-gated (the FREE e2e account's expected path)", async () => {
		createDirectory.mockResolvedValueOnce(mockDir("dot-filen")).mockResolvedValueOnce(mockDir("chat-uploads"))
		uploadFile.mockResolvedValueOnce(mockSdkFile())
		getFileLinkStatus.mockResolvedValueOnce(undefined)
		createFileLink.mockRejectedValueOnce({ species: "sdk", label: "Please upgrade to premium.", message: "premium required" })

		const outcome = await uploadAttachment(mockBrowserFile(), noop)

		expect(outcome).toEqual({
			status: "error",
			dto: { species: "sdk", label: "Please upgrade to premium.", message: "premium required" }
		})
	})

	it("returns an error outcome, never calling createFileLink, when the upload itself fails", async () => {
		createDirectory.mockResolvedValueOnce(mockDir("dot-filen")).mockResolvedValueOnce(mockDir("chat-uploads"))
		uploadFile.mockRejectedValueOnce(new Error("network down"))

		const outcome = await uploadAttachment(mockBrowserFile(), noop)

		expect(outcome.status).toBe("error")
		expect(getFileLinkStatus).not.toHaveBeenCalled()
		expect(createFileLink).not.toHaveBeenCalled()
	})
})

describe("attachExistingDriveItem", () => {
	it("skips upload entirely and creates a fresh link for an item with none yet", async () => {
		const item = narrowItem(mockSdkFile())
		getFileLinkStatus.mockResolvedValueOnce(undefined)
		createFileLink.mockResolvedValueOnce(mockFilePublicLink())

		const outcome = await attachExistingDriveItem(item)

		expect(uploadFile).not.toHaveBeenCalled()
		expect(createFileLink).toHaveBeenCalledOnce()
		expect(outcome.status).toBe("success")
	})

	it("reuses an existing link's url without creating a second one", async () => {
		const item = narrowItem(mockSdkFile())
		getFileLinkStatus.mockResolvedValueOnce(mockFilePublicLink())

		const outcome = await attachExistingDriveItem(item)

		expect(createFileLink).not.toHaveBeenCalled()
		expect(outcome.status).toBe("success")
	})

	it("builds a DIRECTORY-shaped (/d/) url for a directory item, via createDirectoryLink", async () => {
		const item = narrowItem(mockDir("shared-dir"))
		getDirectoryLinkStatus.mockResolvedValueOnce(undefined)
		createDirectoryLink.mockResolvedValueOnce(mockDirPublicLinkRW())

		const outcome = await attachExistingDriveItem(item)

		expect(createDirectoryLink).toHaveBeenCalledOnce()
		expect(outcome.status).toBe("success")
		expect(outcome.status === "success" && outcome.url.startsWith("https://app.filen.io/d/")).toBe(true)
	})
})
