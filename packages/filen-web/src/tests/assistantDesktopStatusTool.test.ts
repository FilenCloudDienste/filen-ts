// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { RegisteredRouter } from "@tanstack/react-router"
import { assistantToolByName, parseToolInput, type AssistantToolFailure } from "@filen/shared/assistant"
import type { DesktopMountsOverview, DesktopSyncOverview, DesktopSyncPair } from "@filen/shared/desktop"

const desktop = vi.hoisted(() => ({ app: true }))
const sdk = vi.hoisted(() => ({ resolveDirectoryName: vi.fn() }))

vi.mock("@/lib/desktop", () => ({ isDesktopApp: () => desktop.app, desktopBridge: () => undefined }))
vi.mock("@/lib/sdk/client", () => ({ sdkApi: sdk }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }))

const { queryClient } = await import("@/queries/client")
const { driveNamesQueryKey } = await import("@/features/drive/queries/drive")
const { useSyncStore } = await import("@/features/sync/lib/syncStore")
const { useMountsStore } = await import("@/features/mounts/lib/mountsStore")
const { setAssistantRouter } = await import("@/features/assistant/tools/navigation")
const { createAssistantToolExecutor } = await import("@/features/assistant/tools/executor")

type Executor = ReturnType<typeof createAssistantToolExecutor>
type Outcome = Awaited<ReturnType<Executor["execute"]>> | AssistantToolFailure

function pair(overrides: Partial<DesktopSyncPair> & Pick<DesktopSyncPair, "id" | "name" | "localRoot" | "remoteRoot">): DesktopSyncPair {
	return {
		mode: "twoWay",
		paused: false,
		phase: "idle",
		progress: null,
		transfers: [],
		lastSyncedAt: null,
		lastError: null,
		issues: { conflicts: 0, heldDeletions: 0, unsyncable: 0, skippedSymlinks: 0, failed: 0 },
		degraded: { local: false, remote: false },
		stage: null,
		halted: null,
		refused: null,
		review: null,
		notices: [],
		rootProblem: null,
		holds: [],
		info: [],
		...overrides
	}
}

const work = pair({
	id: "pair-work",
	name: "Work",
	localRoot: "/Users/me/Work",
	remoteRoot: "remote-work",
	phase: "syncing",
	progress: { done: 12, total: 40 },
	lastError: "Permission denied: report.docx",
	issues: { conflicts: 2, heldDeletions: 0, unsyncable: 0, skippedSymlinks: 0, failed: 1 }
})
const photos = pair({ id: "legacy:photos", name: "Photos", localRoot: "/Users/me/Pictures", remoteRoot: "remote-photos" })

const SYNC: DesktopSyncOverview = { host: { state: "running" }, pairs: [work, photos], importNote: null }

const MOUNTS = {
	host: { state: "running" },
	available: true,
	fuse: { state: "ready", provider: "macFuse" },
	fuseGap: null,
	drive: {
		enabled: true,
		state: "error",
		mountPoint: "/Volumes/Filen",
		driveLetter: null,
		readOnly: false,
		error: { code: "fuseMissing" }
	},
	serves: [],
	protocols: ["webdav"],
	cache: { usedBytes: 1024, freeBytes: 2048, pendingUploads: 3, erroredFiles: 0 },
	tuning: { cacheMaxGiB: 10, cacheMinFreeGiB: 5, cacheMaxAgeHours: 24, dirCacheSeconds: 60 },
	notices: []
} satisfies DesktopMountsOverview

// Lands where it was sent, as the app's router does unless a dialog blocks it.
const router = {
	state: { location: { pathname: "/drive" } },
	subscribe: vi.fn(() => () => undefined),
	navigate: vi.fn((options: { to: string; params?: Record<string, string> }) => {
		router.state.location.pathname = options.to.replace(/\$(\w+)/g, (_match, name: string) => options.params?.[name] ?? "")

		return Promise.resolve()
	})
}

let executor: Executor

async function call(name: string, args: Record<string, unknown>): Promise<Outcome> {
	const tool = assistantToolByName(name)

	if (tool === undefined || !parseToolInput(tool, args).ok) {
		throw new Error(`bad test call ${name}`)
	}

	const checked = await executor.check({ callId: "call", tool, args })

	if (!checked.ok) {
		return checked
	}

	return executor.execute({ callId: "call", tool, args: checked.args, confirmed: false, signal: new AbortController().signal })
}

function result(outcome: Outcome): Record<string, unknown> {
	if (!outcome.ok) {
		throw new Error(outcome.error)
	}

	return outcome.result as Record<string, unknown>
}

beforeEach(() => {
	desktop.app = true
	sdk.resolveDirectoryName.mockReset()
	router.state.location.pathname = "/drive"
	router.navigate.mockClear()
	setAssistantRouter(router as unknown as RegisteredRouter)
	queryClient.clear()
	useSyncStore.setState({ overview: SYNC })
	useMountsStore.setState({ overview: MOUNTS })
	executor = createAssistantToolExecutor()
})

describe("get_desktop_status", () => {
	it("lists each pair from the held overview, the remote name only where the app holds it, without a request", async () => {
		queryClient.setQueryData(driveNamesQueryKey("drive", "remote-work"), "Work (cloud)")

		const status = result(await call("get_desktop_status", { section: "sync" }))

		expect(status["pairs"]).toEqual([
			expect.objectContaining({
				handle: "s1",
				name: "Work",
				local: "/Users/me/Work",
				remote: "Work (cloud)",
				state: "syncing",
				progress: "12/40",
				issues: { conflicts: 2, failed: 1 },
				error: "Permission denied: report.docx"
			}),
			expect.objectContaining({ handle: "s2", name: "Photos", remote: "not loaded", lastSynced: "never this session" })
		])
		expect(sdk.resolveDirectoryName).not.toHaveBeenCalled()
	})

	it("narrows to the pairs whose name or directory holds the words", async () => {
		const status = result(await call("get_desktop_status", { section: "sync", query: "pictures" }))

		expect((status["pairs"] as { name: string }[]).map(row => row.name)).toEqual(["Photos"])
	})

	it("says the status is not loaded yet rather than reporting none", async () => {
		useSyncStore.setState({ overview: null })

		expect(await call("get_desktop_status", { section: "sync" })).toMatchObject({ ok: false })
	})

	it("reports the drive, its error and the cache", async () => {
		expect(result(await call("get_desktop_status", { section: "mounts" }))).toMatchObject({
			drive: { enabled: true, state: "error", at: "/Volumes/Filen", error: "fuseMissing" },
			servers: [],
			cache: { used: expect.any(String) as string, pendingUploads: 3 }
		})
	})

	it("is not offered on the web", async () => {
		desktop.app = false

		const tool = assistantToolByName("get_desktop_status")

		expect(tool === undefined ? undefined : executor.supports?.(tool)).toBe(false)
		expect(await call("get_desktop_status", { section: "sync" })).toMatchObject({ ok: false })
	})
})

describe("open_route with a sync pair handle", () => {
	it("opens the pair's Issues tab", async () => {
		await call("get_desktop_status", { section: "sync" })

		expect(result(await call("open_route", { route: "sync", pair: "s2" }))).toMatchObject({ opened: "sync", tab: "issues" })
		expect(router.navigate).toHaveBeenCalledWith({ to: "/sync/$pairId/$tab", params: { pairId: "legacy:photos", tab: "issues" } })
	})

	it("refuses a pair that is gone and one no result showed", async () => {
		await call("get_desktop_status", { section: "sync" })
		useSyncStore.setState({ overview: { ...SYNC, pairs: [work] } })

		expect(await call("open_route", { route: "sync", pair: "s2" })).toMatchObject({ ok: false })
		expect(await call("open_route", { route: "sync", pair: "s7" })).toMatchObject({ ok: false })
		expect(router.navigate).not.toHaveBeenCalled()
	})
})
