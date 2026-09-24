// @vitest-environment happy-dom

// Request counts for chat link previews against a REAL QueryClient, with the SDK boundary
// (getLinkedFile / getDirPublicLinkInfo) spied: what a message row's mount, FlashList recycle-back and
// a restored persisted entry actually put on the wire.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

const sdk = vi.hoisted(() => ({
	getLinkedFile: vi.fn(),
	getDirPublicLinkInfo: vi.fn()
}))

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))
vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))
vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))
vi.mock("@filen/sdk-rs", () => ({
	MaybeEncryptedUniffi_Tags: { Decrypted: "Decrypted", Encrypted: "Encrypted" }
}))

vi.mock("@filen/shared", async importOriginal => ({
	...(await importOriginal<typeof import("@filen/shared")>()),
	parseFilenPublicLink: (url: string) => {
		if (url.includes("/file/")) {
			return { type: "file", uuid: url.split("/file/")[1], key: "key" }
		}

		if (url.includes("/dir/")) {
			return { type: "directory", uuid: url.split("/dir/")[1], key: "key" }
		}

		return null
	}
}))

vi.mock("@/lib/auth", () => ({
	default: {
		getSdkClients: async () => ({ authedSdkClient: sdk })
	}
}))

// The real TanStack client with the app's refetch defaults, minus the SQLite persister.
vi.mock("@/queries/client", async () => {
	const { QueryClient } = await import("@tanstack/react-query")

	const DEFAULT_QUERY_OPTIONS = {
		refetchOnMount: "always",
		refetchOnReconnect: "always",
		staleTime: 0,
		retry: false,
		networkMode: "offlineFirst"
	} as const

	return {
		default: new QueryClient({
			defaultOptions: {
				queries: DEFAULT_QUERY_OPTIONS
			}
		}),
		DEFAULT_QUERY_OPTIONS
	}
})

import { renderHook, waitFor, cleanup } from "@testing-library/react"
import { QueryClientProvider, onlineManager } from "@tanstack/react-query"
import { createElement, type ReactNode } from "react"
import queryClient from "@/queries/client"
import useChatMessageLinksQuery, {
	BASE_QUERY_KEY,
	chatMessageLinksStaleTime,
	LINK_PREVIEW_STALE_TIME,
	type LinkResult
} from "@/features/chats/queries/useChatMessageLinks.query"
import { sortParams } from "@filen/shared"

const FILE_LINK = { url: "https://app.filen.io/file/f1", start: 0, end: 30 }
const DIR_LINK = { url: "https://app.filen.io/dir/d1", start: 31, end: 60 }
const EXTERNAL_LINK = { url: "https://example.com/a.png", start: 61, end: 90 }

function wrapper({ children }: { children: ReactNode }) {
	return createElement(QueryClientProvider, { client: queryClient }, children)
}

// What Attachments does for one message row; unmounting it is FlashList recycling the cell away.
function mountRow(links: (typeof FILE_LINK)[]) {
	return renderHook(() => useChatMessageLinksQuery({ links }, { enabled: links.length > 0 }), { wrapper })
}

// Lets a mount-triggered fetch (async getSdkClients hop included) reach the SDK before asserting none did.
async function settle(): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, 20))
}

function sdkCalls(): number {
	return sdk.getLinkedFile.mock.calls.length + sdk.getDirPublicLinkInfo.mock.calls.length
}

beforeEach(() => {
	queryClient.clear()
	onlineManager.setOnline(true)
	sdk.getLinkedFile.mockReset()
	sdk.getDirPublicLinkInfo.mockReset()
	sdk.getLinkedFile.mockResolvedValue({ name: { tag: "Decrypted", inner: ["photo.jpg"] }, size: 10n })
	sdk.getDirPublicLinkInfo.mockResolvedValue({ uuid: "d1" })
})

// No vitest globals, so testing-library's auto-cleanup never runs: unmount observers explicitly.
afterEach(() => {
	cleanup()
})

describe("useChatMessageLinksQuery request counts", () => {
	it("recycling a row away and back three times resolves its links once (was once per mount)", async () => {
		for (let i = 0; i < 3; i++) {
			const row = mountRow([FILE_LINK, DIR_LINK])

			await waitFor(() => expect(row.result.current.data).toHaveLength(2))

			row.unmount()
		}

		expect(sdk.getLinkedFile).toHaveBeenCalledTimes(1)
		expect(sdk.getDirPublicLinkInfo).toHaveBeenCalledTimes(1)
	})

	it("a persisted entry older than an hour re-resolves once on first mount", async () => {
		const key = [BASE_QUERY_KEY, sortParams({ links: [FILE_LINK] })]

		queryClient.setQueryData(key, [{ type: "internal", success: false }], { updatedAt: Date.now() - LINK_PREVIEW_STALE_TIME - 1000 })

		const first = mountRow([FILE_LINK])

		await waitFor(() => expect(first.result.current.data?.[0]?.success).toBe(true))

		first.unmount()

		mountRow([FILE_LINK])

		await settle()

		expect(sdkCalls()).toBe(1)
	})

	it("an entry resolved within the hour is served from cache", async () => {
		queryClient.setQueryData(
			[BASE_QUERY_KEY, sortParams({ links: [DIR_LINK] })],
			[{ type: "internal", success: true, data: { type: "directory", info: { uuid: "d1" } } }],
			{ updatedAt: Date.now() - 10 * 60 * 1000 }
		)

		const row = mountRow([DIR_LINK])

		await settle()

		expect(row.result.current.data).toHaveLength(1)
		expect(sdkCalls()).toBe(0)
	})

	it("a failed resolve is retried on every mount, as before", async () => {
		sdk.getLinkedFile.mockRejectedValue(new Error("network"))

		for (let i = 0; i < 2; i++) {
			const row = mountRow([FILE_LINK])

			await waitFor(() => expect(row.result.current.data?.[0]).toEqual({ type: "internal", success: false }))

			row.unmount()
		}

		expect(sdk.getLinkedFile).toHaveBeenCalledTimes(2)
	})

	it("a mounted row still re-resolves on reconnect", async () => {
		const row = mountRow([FILE_LINK])

		await waitFor(() => expect(row.result.current.data).toHaveLength(1))

		onlineManager.setOnline(false)
		onlineManager.setOnline(true)

		await waitFor(() => expect(sdk.getLinkedFile).toHaveBeenCalledTimes(2))
	})

	it("an external-only row makes no SDK request on any mount", async () => {
		for (let i = 0; i < 2; i++) {
			const row = mountRow([EXTERNAL_LINK])

			await waitFor(() => expect(row.result.current.data).toEqual([{ type: "external", success: false }]))

			row.unmount()
		}

		expect(sdkCalls()).toBe(0)
	})

	it("a message without links never queries", async () => {
		mountRow([])

		await settle()

		expect(sdkCalls()).toBe(0)
	})
})

describe("chatMessageLinksStaleTime", () => {
	it("keeps a fully resolved or external-only result for the hour", () => {
		expect(chatMessageLinksStaleTime([{ type: "external", success: false }])).toBe(LINK_PREVIEW_STALE_TIME)
		expect(
			chatMessageLinksStaleTime([{ type: "internal", success: true, data: { type: "directory", info: {} } } as LinkResult])
		).toBe(LINK_PREVIEW_STALE_TIME)
	})

	it("treats any failed Filen link as immediately stale", () => {
		expect(chatMessageLinksStaleTime([{ type: "external", success: false }, { type: "internal", success: false }])).toBe(0)
	})

	it("treats no data as the hour (nothing to keep; the fetch decides)", () => {
		expect(chatMessageLinksStaleTime(undefined)).toBe(LINK_PREVIEW_STALE_TIME)
	})
})
