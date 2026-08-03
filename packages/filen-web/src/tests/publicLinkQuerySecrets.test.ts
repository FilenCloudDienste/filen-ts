// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { createElement, type ReactNode } from "react"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { AnyLinkedDir, DirPublicLink } from "@filen/sdk-rs"

// ★ SECURITY: publicLinksQueryKey.test.ts pins the key BUILDERS; this file pins the four hooks that
// actually call them, because the leak this guards against is a hook composing a key out of the raw
// secrets — the builders would stay green while the fragment key and the visitor password ride
// `queryHash`, which the global queryCache onError logs and the persister uses as an on-disk row name.

const { getLinkedFileAnon, getDirPublicLinkInfoAnon, getLinkedDirSizeAnon, listLinkedDirAnon } = vi.hoisted(() => ({
	getLinkedFileAnon: vi.fn(() => Promise.resolve({})),
	getDirPublicLinkInfoAnon: vi.fn(() => Promise.resolve({})),
	getLinkedDirSizeAnon: vi.fn(() => Promise.resolve({})),
	listLinkedDirAnon: vi.fn(() => Promise.resolve({}))
}))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: { getLinkedFileAnon, getDirPublicLinkInfoAnon, getLinkedDirSizeAnon, listLinkedDirAnon }
}))

import { usePublicFile, usePublicDirInfo, usePublicDirSize, usePublicDirListing } from "@/features/publicLinks/queries/publicLink"

// A raw fragment key (64 hex → 32-byte key) and a visitor password, the two secrets that must not leak.
const RAW_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
const RAW_PASSWORD = "hunter2-super-secret"
const UUID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"

const dir = { uuid: UUID } as unknown as AnyLinkedDir
const link = { linkKey: RAW_KEY, password: RAW_PASSWORD } as unknown as DirPublicLink

function renderPublicLinkQueries() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
	const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client, children })

	const rendered = renderHook(
		() => {
			usePublicFile(UUID, RAW_KEY, RAW_PASSWORD)
			usePublicDirInfo(UUID, RAW_KEY)
			usePublicDirSize({ levelUuid: UUID, dir, link })
			usePublicDirListing({ levelUuid: UUID, dir, link })
		},
		{ wrapper }
	)

	return { ...rendered, client }
}

describe("public-link hooks — no secret ever reaches a query key", () => {
	it("keys every one of the four viewer queries by fingerprint alone", async () => {
		const { client } = renderPublicLinkQueries()

		await waitFor(() => {
			expect(client.getQueryCache().getAll().length).toBe(4)
		})

		for (const query of client.getQueryCache().getAll()) {
			expect(query.queryHash).not.toContain(RAW_KEY)
			expect(query.queryHash).not.toContain(RAW_PASSWORD)
			expect(JSON.stringify(query.queryKey)).not.toContain(RAW_KEY)
			expect(JSON.stringify(query.queryKey)).not.toContain(RAW_PASSWORD)
		}
	})

	// The mirror half: the secrets must still reach the worker call itself — a key that carries no
	// secret is worthless if the fix was to stop passing them at all.
	it("still hands both secrets to the unauthenticated worker calls themselves", async () => {
		renderPublicLinkQueries()

		await waitFor(() => {
			expect(getLinkedFileAnon).toHaveBeenCalledWith(UUID, RAW_KEY, RAW_PASSWORD)
		})

		expect(getDirPublicLinkInfoAnon).toHaveBeenCalledWith(UUID, RAW_KEY)
		expect(getLinkedDirSizeAnon).toHaveBeenCalledWith({ dir, link })
		expect(listLinkedDirAnon).toHaveBeenCalledWith(dir, link)
	})
})
