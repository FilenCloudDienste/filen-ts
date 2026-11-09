import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DesktopMountsResult } from "@filen/shared/desktop"
import { VERDICT_KV_PREFIX } from "@filen/shared"

// The Storage page's measure and clear logic, over spies for every store it touches.

const mocks = vi.hoisted(() => ({
	kvPrefixBytes: vi.fn<(prefixes: readonly string[]) => Promise<number[] | null>>(),
	kvDeletePrefix: vi.fn<(prefix: string) => Promise<void>>(),
	vacuumDatabase: vi.fn<() => Promise<number>>(),
	opfsTreeBytes: vi.fn<(segments: readonly string[]) => Promise<number>>(),
	wipeThumbnailStore: vi.fn<() => Promise<void>>(),
	wipeArtStore: vi.fn<() => Promise<void>>(),
	wipeVideoIndexStore: vi.fn<() => Promise<void>>(),
	resetTrackTags: vi.fn(),
	removeAssistantModel: vi.fn<() => Promise<void>>(),
	deleteModels: vi.fn<() => Promise<void>>(),
	modelState: "downloaded",
	bridge: undefined as
		| undefined
		| {
				app: { browserCacheSize: () => Promise<number>; clearBrowserCache: () => Promise<void> }
				mounts: { clearCache: () => Promise<DesktopMountsResult<null>> }
		  }
}))

vi.mock("@/lib/storage/adapter", () => ({
	kvPrefixBytes: mocks.kvPrefixBytes,
	kvDeletePrefix: mocks.kvDeletePrefix,
	vacuumDatabase: mocks.vacuumDatabase
}))
vi.mock("@/lib/storage/opfs", () => ({ opfsTreeBytes: mocks.opfsTreeBytes }))
vi.mock("@/features/drive/lib/thumbCache", () => ({ wipeThumbnailStore: mocks.wipeThumbnailStore }))
vi.mock("@/features/videos/lib/artStore", () => ({ wipeArtStore: mocks.wipeArtStore }))
vi.mock("@/features/videos/lib/indexStore", () => ({ wipeVideoIndexStore: mocks.wipeVideoIndexStore }))
vi.mock("@/features/audio/store/useTrackTagsStore", () => ({ resetTrackTags: mocks.resetTrackTags }))
vi.mock("@/features/assistant/store/assistantSession", () => ({ removeAssistantModel: mocks.removeAssistantModel }))
vi.mock("@/features/assistant/store/useAssistantStore", () => ({
	useAssistantStore: { getState: () => ({ modelState: { kind: mocks.modelState } }) }
}))
vi.mock("@/features/assistant/runtime/modelStore", () => ({
	MODEL_LOCK: "filen-assistant-model",
	MODELS_DIRECTORY: "models",
	deleteModels: mocks.deleteModels
}))
vi.mock("@/queries/persist", () => ({ PERSIST_FAMILY: "rq." }))
vi.mock("@/lib/desktop", () => ({ desktopBridge: () => mocks.bridge }))

const { clearAllRows, clearRow, clearRows, measureRow, removeModel, ModelInUseError, CacheClearError, CLEAR_ALL_ROWS } =
	await import("@/features/settings/lib/localCaches")
const { VIDEO_CACHE_KV_PREFIXES } = await import("@/features/videos/lib/cacheKeys.logic")

// Rows a cache clear must never reach: the session, outboxes, history, watch state, preferences, verdicts.
const PROTECTED_KEYS = [
	"sdk.session.v1",
	"inflightNoteContent",
	"inflightChatMessages",
	"assistant.v1.history.c1",
	"photos.library.v1",
	"keymap.v1.overrides",
	"videos.v1.r.s:uuid",
	"videos.v1.r.d:uuid",
	"videos.v1.meta",
	"videos.v1.head",
	"videos.v1.device",
	"videos.v1.grid.root:r1",
	"videos.v1.season.t1",
	"video.cap.v1:hevc",
	"audio.v1.prefs",
	"drive.sortPreferences.v1",
	"notes.defaultType.v1",
	`${VERDICT_KV_PREFIX}uuid`
]

function locksGranting(granted: boolean) {
	vi.stubGlobal("navigator", {
		locks: {
			request: (_name: string, _options: object, callback: (lock: { name: string } | null) => Promise<boolean>) =>
				callback(granted ? { name: "filen-assistant-model" } : null)
		}
	})
}

beforeEach(() => {
	vi.unstubAllGlobals()

	for (const spy of [mocks.kvDeletePrefix, mocks.wipeThumbnailStore, mocks.wipeArtStore, mocks.wipeVideoIndexStore]) {
		spy.mockReset().mockResolvedValue(undefined)
	}

	mocks.kvPrefixBytes.mockReset().mockImplementation(prefixes => Promise.resolve(prefixes.map(() => 10)))
	mocks.vacuumDatabase.mockReset().mockResolvedValue(0)
	mocks.opfsTreeBytes.mockReset().mockResolvedValue(100)
	mocks.resetTrackTags.mockReset()
	mocks.removeAssistantModel.mockReset().mockResolvedValue(undefined)
	mocks.deleteModels.mockReset().mockResolvedValue(undefined)
	mocks.modelState = "downloaded"
	mocks.bridge = {
		app: { browserCacheSize: vi.fn(() => Promise.resolve(7)), clearBrowserCache: vi.fn(() => Promise.resolve()) },
		mounts: { clearCache: vi.fn(() => Promise.resolve({ ok: true as const, value: null })) }
	}
})

describe("video cache prefixes", () => {
	it("cover the derived families and none of the user's own rows", () => {
		for (const key of ["videos.v1.probe.u", "videos.v1.nfo.u", "videos.v1.art.u", "videos.v1.frame.u", "videos.v1.subenc.u"]) {
			expect(VIDEO_CACHE_KV_PREFIXES.some(prefix => key.startsWith(prefix))).toBe(true)
		}

		expect(VIDEO_CACHE_KV_PREFIXES).not.toContain("videos.v1.")
	})
})

describe("measureRow", () => {
	it("measures the trees each wipe removes, at their roots", async () => {
		expect(await measureRow("thumbnails")).toBe(100)
		expect(mocks.opfsTreeBytes).toHaveBeenLastCalledWith(["thumbnails"], undefined)
		expect(await measureRow("model")).toBe(100)
		expect(mocks.opfsTreeBytes).toHaveBeenLastCalledWith(["models"], undefined)
	})

	it("adds the Videos artwork, index and kv rows", async () => {
		expect(await measureRow("videos")).toBe(100 + 100 + 10 * VIDEO_CACHE_KV_PREFIXES.length)
		expect(mocks.opfsTreeBytes.mock.calls.map(([segments]) => segments)).toEqual([
			["videos", "art"],
			["videos", "index"]
		])
		expect(mocks.kvPrefixBytes).toHaveBeenCalledWith(VIDEO_CACHE_KV_PREFIXES)
	})

	it("measures music and the query cache by their kv prefixes", async () => {
		expect(await measureRow("music")).toBe(10)
		expect(mocks.kvPrefixBytes).toHaveBeenLastCalledWith(["audio.v1.tags."])
		expect(await measureRow("queryCache")).toBe(10)
		expect(mocks.kvPrefixBytes).toHaveBeenLastCalledWith(["rq."])
	})

	it("answers null for kv rows when the leader cannot measure them", async () => {
		mocks.kvPrefixBytes.mockResolvedValue(null)

		expect(await measureRow("music")).toBeNull()
		expect(await measureRow("queryCache")).toBeNull()
		expect(await measureRow("videos")).toBe(200)
	})

	it("asks the shell for the browser cache, and has none in a browser", async () => {
		expect(await measureRow("browserCache")).toBe(7)

		mocks.bridge = undefined

		expect(await measureRow("browserCache")).toBeNull()
	})
})

describe("clearRow", () => {
	it("wipes the whole thumbnail tree and nothing in kv", async () => {
		await expect(clearRow("thumbnails")).resolves.toEqual({ kind: "cleared" })
		expect(mocks.wipeThumbnailStore).toHaveBeenCalledOnce()
		expect(mocks.kvDeletePrefix).not.toHaveBeenCalled()
		expect(mocks.vacuumDatabase).not.toHaveBeenCalled()
	})

	it("clears Videos artwork, index and every derived kv family, then compacts", async () => {
		await clearRow("videos")

		expect(mocks.wipeArtStore).toHaveBeenCalledOnce()
		expect(mocks.wipeVideoIndexStore).toHaveBeenCalledOnce()
		expect(mocks.kvDeletePrefix.mock.calls.map(([prefix]) => prefix)).toEqual([...VIDEO_CACHE_KV_PREFIXES])
		expect(mocks.vacuumDatabase).toHaveBeenCalledOnce()
	})

	it("drops this tab's track tags with their rows", async () => {
		await clearRow("music")

		expect(mocks.kvDeletePrefix).toHaveBeenCalledWith("audio.v1.tags.")
		expect(mocks.resetTrackTags).toHaveBeenCalledOnce()
	})

	it("clears the persisted query rows", async () => {
		await clearRow("queryCache")

		expect(mocks.kvDeletePrefix).toHaveBeenCalledWith("rq.")
		expect(mocks.vacuumDatabase).toHaveBeenCalledOnce()
	})

	it("keeps a cleared row cleared when the compaction fails", async () => {
		mocks.vacuumDatabase.mockRejectedValue(new DOMException("quota", "QuotaExceededError"))

		await expect(clearRow("queryCache")).resolves.toEqual({ kind: "cleared" })
	})

	it("reports a failed clear with its row", async () => {
		mocks.wipeArtStore.mockRejectedValue(new Error("locked"))

		const error = await clearRow("videos").catch((e: unknown) => e)

		expect(error).toBeInstanceOf(CacheClearError)
		expect((error as InstanceType<typeof CacheClearError>).row).toBe("videos")
		// Every part still ran.
		expect(mocks.wipeVideoIndexStore).toHaveBeenCalledOnce()
		expect(mocks.kvDeletePrefix).toHaveBeenCalledTimes(VIDEO_CACHE_KV_PREFIXES.length)
	})

	it("clears the desktop browser cache through the shell", async () => {
		await clearRow("browserCache")

		expect(mocks.bridge?.app.clearBrowserCache).toHaveBeenCalledOnce()
	})

	it("skips the network drive cache when the shell refuses for pending uploads", async () => {
		vi.mocked(mocks.bridge?.mounts.clearCache ?? vi.fn()).mockResolvedValue({ ok: false, error: { code: "uploadsPending" } })

		await expect(clearRow("networkDrive")).resolves.toEqual({ kind: "skipped", reason: "uploadsPending" })
	})

	it("fails on any other network drive refusal", async () => {
		vi.mocked(mocks.bridge?.mounts.clearCache ?? vi.fn()).mockResolvedValue({ ok: false, error: { code: "hostUnavailable" } })

		await expect(clearRow("networkDrive")).rejects.toBeInstanceOf(CacheClearError)
	})
})

describe("Clear all", () => {
	it("never includes the AI model", () => {
		expect(CLEAR_ALL_ROWS).not.toContain("model")
		expect(clearAllRows(true, 5)).toEqual(["thumbnails", "videos", "music", "queryCache", "browserCache", "networkDrive"])
	})

	it("leaves out the desktop rows in a browser, and a network drive with nothing cached", () => {
		expect(clearAllRows(false, 5)).toEqual(["thumbnails", "videos", "music", "queryCache"])
		expect(clearAllRows(true, 0)).not.toContain("networkDrive")
		expect(clearAllRows(true, null)).not.toContain("networkDrive")
	})

	it("deletes only named prefixes, none of which reaches a protected row", async () => {
		await clearRows(clearAllRows(true, 5))

		const deleted = mocks.kvDeletePrefix.mock.calls.map(([prefix]) => prefix)

		expect(deleted).not.toContain("")

		for (const key of PROTECTED_KEYS) {
			expect(deleted.filter(prefix => key.startsWith(prefix))).toEqual([])
		}

		expect(mocks.removeAssistantModel).not.toHaveBeenCalled()
		expect(mocks.deleteModels).not.toHaveBeenCalled()
	})

	it("runs every row to its end, sorts the outcomes and compacts once", async () => {
		mocks.wipeThumbnailStore.mockRejectedValue(new Error("busy"))
		vi.mocked(mocks.bridge?.mounts.clearCache ?? vi.fn()).mockResolvedValue({ ok: false, error: { code: "uploadsPending" } })

		const result = await clearRows(clearAllRows(true, 5))

		expect(result).toEqual({
			cleared: ["videos", "music", "queryCache", "browserCache"],
			skipped: ["networkDrive"],
			failed: ["thumbnails"]
		})
		expect(mocks.vacuumDatabase).toHaveBeenCalledOnce()
	})
})

describe("removeModel", () => {
	it("goes through the runtime, which unloads it first", async () => {
		await removeModel()

		expect(mocks.removeAssistantModel).toHaveBeenCalledOnce()
		expect(mocks.deleteModels).not.toHaveBeenCalled()
	})

	it("removes the files directly under the model lock when the runtime never looked at the disk", async () => {
		mocks.modelState = "unavailable"
		locksGranting(true)

		await removeModel()

		expect(mocks.deleteModels).toHaveBeenCalledOnce()
		expect(mocks.removeAssistantModel).not.toHaveBeenCalled()
	})

	it("refuses while another tab holds the model", async () => {
		mocks.modelState = "unavailable"
		locksGranting(false)

		await expect(removeModel()).rejects.toBeInstanceOf(ModelInUseError)
		expect(mocks.deleteModels).not.toHaveBeenCalled()
	})
})
