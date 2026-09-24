// @vitest-environment happy-dom
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"
import { cleanup, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { type ReactNode } from "react"

const sdk = vi.hoisted(() => ({
	getDirOptional: vi.fn(),
	getFileOptional: vi.fn()
}))

vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))
vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))
vi.mock("@filen/sdk-rs", () => ({ AnyNormalDir: {}, AnySharedDir: {}, AnySharedDirWithContext: {}, AnyLinkedDir: {} }))
vi.mock("@/lib/auth", () => ({ default: { getSdkClients: async () => ({ authedSdkClient: sdk }) } }))

import useLinkSaveable, { isLinkOwned } from "@/features/drive/hooks/useLinkSaveable"
import cache from "@/lib/cache"
import type { AnyNormalDir, File } from "@filen/sdk-rs"
import type { LinkSaveTarget } from "@/features/drive/linkedSave"

let queryClient: QueryClient

function wrapper({ children }: { children: ReactNode }) {
	return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

beforeEach(() => {
	vi.clearAllMocks()
	cache.clear()
	queryClient = new QueryClient()
})

afterEach(() => {
	cleanup()
	queryClient.clear()
})

describe("isLinkOwned request counts", () => {
	it("answers from the own-item cache with 0 requests", async () => {
		cache.directoryUuidToAnyNormalDir.set("root-1", {} as AnyNormalDir)
		cache.fileUuidToNormalFile.set("f-1", {} as File)

		expect(await isLinkOwned({ kind: "directory", uuid: "root-1" })).toBe(true)
		expect(await isLinkOwned({ kind: "file", uuid: "f-1" })).toBe(true)
		expect(sdk.getDirOptional).not.toHaveBeenCalled()
		expect(sdk.getFileOptional).not.toHaveBeenCalled()
	})

	it("otherwise asks the owner-only lookup once, of the right kind", async () => {
		sdk.getDirOptional.mockResolvedValueOnce({ uuid: "root-1" })
		sdk.getFileOptional.mockResolvedValueOnce(undefined)

		expect(await isLinkOwned({ kind: "directory", uuid: "root-1" })).toBe(true)
		expect(await isLinkOwned({ kind: "file", uuid: "f-2" })).toBe(false)
		expect(sdk.getDirOptional).toHaveBeenCalledTimes(1)
		expect(sdk.getFileOptional).toHaveBeenCalledTimes(1)
	})

	it("counts a failed lookup as not owned", async () => {
		sdk.getDirOptional.mockRejectedValueOnce(new Error("offline"))

		expect(await isLinkOwned({ kind: "directory", uuid: "root-1" })).toBe(false)
	})
})

describe("useLinkSaveable", () => {
	const target: LinkSaveTarget = { kind: "directory", uuid: "root-9" }

	it("is saveable for a foreign link, asked once however many rows and remounts ask", async () => {
		sdk.getDirOptional.mockResolvedValue(undefined)

		const a = renderHook(() => useLinkSaveable(target), { wrapper })
		const b = renderHook(() => useLinkSaveable(target), { wrapper })

		await waitFor(() => {
			expect(a.result.current).toBe(true)
			expect(b.result.current).toBe(true)
		})

		a.unmount()

		const c = renderHook(() => useLinkSaveable(target), { wrapper })

		expect(c.result.current).toBe(true)
		expect(sdk.getDirOptional).toHaveBeenCalledTimes(1)
	})

	it("is not saveable for an own link, nor before the answer, nor without a target", async () => {
		sdk.getDirOptional.mockResolvedValueOnce({ uuid: "root-9" })

		const own = renderHook(() => useLinkSaveable(target), { wrapper })

		expect(own.result.current).toBe(false)

		await waitFor(() => {
			expect(sdk.getDirOptional).toHaveBeenCalledTimes(1)
		})

		expect(own.result.current).toBe(false)

		const none = renderHook(() => useLinkSaveable(null), { wrapper })

		expect(none.result.current).toBe(false)
		expect(sdk.getDirOptional).toHaveBeenCalledTimes(1)
	})
})
