// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, renderHook, waitFor } from "@testing-library/react"
import type { VideoRootStatus } from "@/workers/videoIndex/view.logic"
import type { VideoLibraryRootView } from "@/features/videos/lib/libraryView.logic"

// A directory's name comes from the index; its chain (resolved with the drive lock held) only when the index has
// none for it, never while the index is still loading it.

const { sdkApi } = vi.hoisted(() => ({
	sdkApi: { directoryRootChain: vi.fn<(uuid: string) => Promise<{ uuid: string; name: string }[] | null>>() }
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi }))
vi.mock("@/queries/client", async () => ({ queryClient: (await import("@/tests/testQueryClient")).createTestQueryClient() }))
vi.mock("@/queries/persist", () => ({ persister: { persistQuery: () => Promise.resolve() }, noDiskPersister: undefined }))

import { queryClient } from "@/queries/client"
import { queryClientWrapper } from "@/tests/testQueryClient"
import { useVideoRootNames } from "@/features/videos/hooks/useVideoLibraryView"

function status(uuid: string, patch: Partial<VideoRootStatus>): VideoRootStatus {
	return {
		uuid,
		name: "",
		type: "auto",
		state: "ready",
		walking: false,
		current: true,
		completeAt: 0,
		walkedEntries: 0,
		size: "normal",
		videos: 0,
		moved: false,
		incomplete: false,
		...patch
	}
}

function root(uuid: string, patch: Partial<VideoLibraryRootView>): VideoLibraryRootView {
	return { uuid, type: "auto", enabled: true, status: undefined, phase: "ready", ...patch }
}

afterEach(() => {
	cleanup()
	queryClient.clear()
	sdkApi.directoryRootChain.mockReset()
})

describe("library directory names", () => {
	it("resolves a chain only for a directory the index has no name for, never while it loads one", async () => {
		sdkApi.directoryRootChain.mockImplementation(uuid =>
			Promise.resolve([
				{ uuid: "drive", name: "" },
				{ uuid, name: `chain ${uuid}` }
			])
		)

		const roots = [
			root("reported", { status: status("reported", { name: "Films" }) }),
			root("unreported", {}),
			root("loading", { status: status("loading", { state: "loading" }) }),
			root("off", { enabled: false }),
			root("unnamed", { status: status("unnamed", { state: "missing" }) })
		]
		const { result } = renderHook(() => useVideoRootNames(roots), { wrapper: queryClientWrapper(queryClient) })

		await waitFor(() => {
			expect(result.current.get("off")).toBe("chain off")
		})

		expect(result.current.get("reported")).toBe("Films")
		expect(result.current.get("unnamed")).toBe("chain unnamed")
		expect(sdkApi.directoryRootChain.mock.calls.map(([uuid]) => uuid).sort()).toEqual(["off", "unnamed"])
	})
})
