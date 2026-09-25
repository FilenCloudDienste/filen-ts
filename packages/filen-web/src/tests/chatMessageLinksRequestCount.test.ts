// @vitest-environment jsdom

import { Buffer } from "buffer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, type ReactNode } from "react"
import { act, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query"
import type { LinkedFile } from "@filen/sdk-rs"

const { getLinkedFile, getDirPublicLinkInfo } = vi.hoisted(() => ({
	getLinkedFile: vi.fn<(linkUuid: string, fileKey: string) => Promise<LinkedFile>>(),
	getDirPublicLinkInfo: vi.fn()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { getLinkedFile, getDirPublicLinkInfo } }))

import {
	CHAT_MESSAGE_LINKS_FAILED_STALE_TIME,
	CHAT_MESSAGE_LINKS_STALE_TIME,
	useChatMessageLinksQuery
} from "@/features/chats/queries/chatMessageLinks"

const UUID = "11111111-1111-4111-8111-111111111111"
const KEY_PLAINTEXT = "0123456789abcdef0123456789abcdef"
const FILE_LINK_URL = `https://app.filen.io/#/d/${UUID}%23${Buffer.from(KEY_PLAINTEXT, "utf-8").toString("hex")}`
const IMAGE_URL = "https://example.com/photo.jpg"
const URLS = [FILE_LINK_URL, IMAGE_URL]

const LINKED_FILE: LinkedFile = {
	uuid: UUID,
	name: { Decrypted: "photo.jpg" },
	mime: { Decrypted: "image/jpeg" },
	size: 1024n,
	chunks: 1n,
	region: "region",
	bucket: "bucket",
	version: 2,
	timestamp: 0n,
	fileKey: KEY_PLAINTEXT,
	downloadable: true,
	linkedTag: true,
	canMakeThumbnail: false
}

const fetchSpy = vi.fn(() => Promise.resolve({ ok: true, headers: { get: () => "image/jpeg" } }))

// The production defaults minus the persister (sqlite, unavailable under vitest).
let queryClient: QueryClient

function wrapper({ children }: { children: ReactNode }) {
	return createElement(QueryClientProvider, { client: queryClient, children })
}

function mountEmbeds() {
	return renderHook(() => useChatMessageLinksQuery(URLS), { wrapper })
}

async function drain(): Promise<void> {
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, 0))
	})
	await waitFor(() => {
		expect(queryClient.isFetching()).toBe(0)
	})
}

beforeEach(() => {
	queryClient = new QueryClient({
		defaultOptions: {
			queries: { staleTime: 0, gcTime: Infinity, retry: false, refetchOnWindowFocus: true, refetchOnReconnect: true }
		}
	})
	getLinkedFile.mockResolvedValue(LINKED_FILE)
	vi.stubGlobal("fetch", fetchSpy)
})

afterEach(() => {
	queryClient.clear()
	focusManager.setFocused(undefined)
	vi.useRealTimers()
	vi.clearAllMocks()
	vi.unstubAllGlobals()
})

describe("chat message link embed request counts", () => {
	it("a row remounting after scrolling back into view reuses the resolved links, as does focus", async () => {
		const first = mountEmbeds()
		await drain()
		first.unmount()

		expect(getLinkedFile).toHaveBeenCalledTimes(1)
		expect(fetchSpy).toHaveBeenCalledTimes(1)

		const row = mountEmbeds()
		await drain()

		expect(row.result.current.data).toHaveLength(2)

		act(() => {
			focusManager.setFocused(false)
			focusManager.setFocused(true)
		})
		await drain()

		expect(getLinkedFile).toHaveBeenCalledTimes(1)
		expect(fetchSpy).toHaveBeenCalledTimes(1)

		row.unmount()
	})

	// Resolves once, then remounts after each offset (ms after the first resolution) and returns the
	// resolution count seen after each remount.
	async function countsAfterRemounts(offsets: number[]): Promise<number[]> {
		vi.useFakeTimers({ toFake: ["Date"] })

		const start = Date.now()
		const first = mountEmbeds()
		await drain()
		first.unmount()

		const counts: number[] = []

		for (const offset of offsets) {
			vi.setSystemTime(start + offset)

			const row = mountEmbeds()
			await drain()
			row.unmount()

			counts.push(getLinkedFile.mock.calls.length)
			expect(fetchSpy).toHaveBeenCalledTimes(getLinkedFile.mock.calls.length)
		}

		return counts
	}

	it("a fully resolved row holds past the failure window and re-resolves only after the stale time", async () => {
		expect(await countsAfterRemounts([CHAT_MESSAGE_LINKS_FAILED_STALE_TIME + 1, CHAT_MESSAGE_LINKS_STALE_TIME + 1])).toEqual([1, 2])
	})

	it("a row with a failed resolution retries after the failure window but not before", async () => {
		getLinkedFile.mockRejectedValue(new Error("network"))

		expect(await countsAfterRemounts([CHAT_MESSAGE_LINKS_FAILED_STALE_TIME - 1, CHAT_MESSAGE_LINKS_FAILED_STALE_TIME + 1])).toEqual([
			1, 2
		])
	})
})
