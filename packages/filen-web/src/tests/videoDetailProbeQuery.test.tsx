// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, renderHook, waitFor } from "@testing-library/react"
import type { VideoPartView } from "@/workers/videoIndex/view.logic"

// The detail page's probe: a null answer (offline, dropped, failed) is asked again on the next mount; a probe is kept.

const { probeService, videoLibrary } = vi.hoisted(() => ({
	probeService: { request: vi.fn<() => Promise<{ probe: unknown } | null>>() },
	videoLibrary: { playableFiles: vi.fn(() => Promise.resolve([{ uuid: "file" }])) }
}))

vi.mock("@/features/videos/lib/probeService", () => ({ probeService }))
vi.mock("@/features/videos/lib/index", () => ({ videoLibrary }))
vi.mock("@/features/videos/lib/records", () => ({ probeRecords: { get: vi.fn() } }))
vi.mock("@/features/videos/lib/nfoReader", () => ({ readNfo: vi.fn() }))
vi.mock("@/lib/media/playback/capabilities", () => ({ playbackCapabilities: {} }))
vi.mock("@/lib/storage/adapter", () => ({ kvGetJson: () => Promise.resolve(null), kvSetJson: () => Promise.resolve() }))
vi.mock("@/queries/client", async () => ({ queryClient: (await import("@/tests/testQueryClient")).createTestQueryClient() }))
vi.mock("@/queries/persist", () => ({ persister: { persistQuery: () => Promise.resolve() }, noDiskPersister: undefined }))

import { queryClient } from "@/queries/client"
import { queryClientWrapper } from "@/tests/testQueryClient"
import { useDetailProbeQuery } from "@/features/videos/queries/detail"

const part = { file: { uuid: "file", stableUuid: "stable" }, unsupported: false } as unknown as VideoPartView
const probe = { durationSeconds: 60 }

afterEach(() => {
	cleanup()
	queryClient.clear()
	probeService.request.mockReset()
})

function mount() {
	return renderHook(() => useDetailProbeQuery(part), { wrapper: queryClientWrapper(queryClient) })
}

describe("detail probe query", () => {
	it("asks again on the next mount after a null answer", async () => {
		probeService.request.mockResolvedValueOnce(null)

		const first = mount()

		await waitFor(() => {
			expect(first.result.current.isSuccess).toBe(true)
		})
		expect(first.result.current.data).toBeNull()
		first.unmount()

		probeService.request.mockResolvedValueOnce({ probe })

		const second = mount()

		await waitFor(() => {
			expect(second.result.current.data).toEqual(probe)
		})
		expect(probeService.request).toHaveBeenCalledTimes(2)
	})

	it("keeps a probe without asking again", async () => {
		probeService.request.mockResolvedValue({ probe })

		const first = mount()

		await waitFor(() => {
			expect(first.result.current.data).toEqual(probe)
		})
		first.unmount()

		const second = mount()

		expect(second.result.current.data).toEqual(probe)
		await new Promise(resolve => setTimeout(resolve, 20))
		expect(probeService.request).toHaveBeenCalledTimes(1)
	})
})
