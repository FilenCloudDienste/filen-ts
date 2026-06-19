// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))
import { renderHook, act, cleanup } from "@testing-library/react"

// ------------------------------------------------------------------
// Hoisted spies / mocks (must be defined before the imports they back)
// ------------------------------------------------------------------

const { driveSearchMock, snapshotHolder, removeFromSelection, gates } = vi.hoisted(() => ({
	driveSearchMock: {
		open: vi.fn(),
		setName: vi.fn(async () => true),
		closeActive: vi.fn(async () => {})
	},
	// The driveSearch singleton hands its onSnapshot callback to open(); tests grab it
	// here and drive snapshots through it (the singleton itself is fully mocked).
	snapshotHolder: { onSnapshot: null as ((snapshot: unknown) => void) | null },
	removeFromSelection: vi.fn(),
	// Reactive gates the hook reads — held in a box so a rerender() re-reads them.
	gates: { online: true, appActive: true, focused: true }
}))

vi.mock("@/features/drive/driveSearch", () => ({
	default: {
		open: driveSearchMock.open,
		setName: driveSearchMock.setName,
		closeActive: driveSearchMock.closeActive
	}
}))

// Runtime enum tags the hook pulls from the SDK: result discrimination + meta-tag (read by the
// content-signature that re-maps a remotely-renamed result whose uuid is preserved).
vi.mock("@filen/sdk-rs", () => ({
	CacheSearchResult_Tags: { File: "File", Dir: "Dir" },
	DirMeta_Tags: { Decoded: "Decoded" },
	FileMeta_Tags: { Decoded: "Decoded" }
}))

// Passthrough unwrap → a minimal DriveItem carrying `type` + `data.uuid` (+ `data.name` when the
// raw hit carries decoded meta, so the content-signature / re-map path is observable in tests).
vi.mock("@/lib/sdkUnwrap", () => {
	type RawWithMeta = { uuid: string; meta?: { tag: string; inner: [{ name: string }] } }
	const nameOf = (x: RawWithMeta) => (x.meta?.tag === "Decoded" ? x.meta.inner[0].name : undefined)

	return {
		unwrapDirMeta: (dir: RawWithMeta) => dir,
		unwrappedDirIntoDriveItem: (dir: RawWithMeta) => ({ type: "directory", data: { uuid: dir.uuid, name: nameOf(dir) } }),
		unwrapFileMeta: (file: RawWithMeta) => file,
		unwrappedFileIntoDriveItem: (file: RawWithMeta) => ({ type: "file", data: { uuid: file.uuid, name: nameOf(file) } })
	}
})

vi.mock("@/hooks/useIsOnline", () => ({ default: () => gates.online }))
vi.mock("@/hooks/useIsAppActive", () => ({ default: () => gates.appActive }))
vi.mock("expo-router", () => ({ useIsFocused: () => gates.focused }))

vi.mock("@/features/drive/store/useDrive.store", () => ({
	useDriveStore: { getState: () => ({ removeFromSelection }) }
}))

// Real (no native deps): events (EventEmitter3), the search status store + app store (zustand).
import { useDriveSearch } from "@/features/drive/hooks/useDriveSearch"
import type { DrivePath } from "@/hooks/useDrivePath"
import type { DriveItem } from "@/types"
import events from "@/lib/events"
import { useDriveSearchStore } from "@/features/drive/store/useDriveSearch.store"
import { useAppStore } from "@/stores/useApp.store"

const SETCONFIG_DEBOUNCE_MS = 350
const GRACE_MS = 400
const WATCHDOG_MS = 15_000
const STALL_CEILING_MS = 30_000

function drivePath(over?: Partial<DrivePath>): DrivePath {
	return {
		type: "drive",
		uuid: null,
		...over
	} as DrivePath
}

function dirResult(uuid: string, parentPath = "", name?: string) {
	const dir = name !== undefined ? { uuid, meta: { tag: "Decoded", inner: [{ name }] } } : { uuid }

	return { parentPath, result: { tag: "Dir", inner: { dir } } }
}

function fileResult(uuid: string, parentPath = "", name?: string) {
	const file = name !== undefined ? { uuid, meta: { tag: "Decoded", inner: [{ name }] } } : { uuid }

	return { parentPath, result: { tag: "File", inner: { file } } }
}

function snapshot({ results = [], total = 0n, live = true }: { results?: unknown[]; total?: bigint; live?: boolean } = {}) {
	return { results, total, live }
}

function deliver(snap: ReturnType<typeof snapshot>): void {
	act(() => {
		snapshotHolder.onSnapshot?.(snap)
	})
}

async function advance(ms: number): Promise<void> {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms)
	})
}

function render() {
	return renderHook(({ path }: { path: DrivePath }) => useDriveSearch({ drivePath: path }), {
		initialProps: { path: drivePath() }
	})
}

beforeEach(() => {
	vi.useFakeTimers()

	driveSearchMock.open.mockReset()
	driveSearchMock.open.mockImplementation(async (args: { onSnapshot: (snapshot: unknown) => void }) => {
		// Capture synchronously (no await before the assignment) so the callback is
		// available the moment Effect A fires.
		snapshotHolder.onSnapshot = args.onSnapshot
	})
	driveSearchMock.setName.mockReset()
	driveSearchMock.setName.mockResolvedValue(true)
	driveSearchMock.closeActive.mockClear()
	snapshotHolder.onSnapshot = null
	removeFromSelection.mockClear()

	gates.online = true
	gates.appActive = true
	gates.focused = true

	useDriveSearchStore.setState({ resyncing: false, rootDeleted: false, cacheUnavailable: false })
	useAppStore.setState({ biometricUnlocked: true })
})

afterEach(() => {
	// Unmount every rendered hook so a persistent mount can't re-fire effects across
	// tests when a later beforeEach mutates the shared gates / zustand stores.
	cleanup()
	vi.useRealTimers()
})

describe("useDriveSearch — gating + lifecycle", () => {
	it("is idle with an empty query and never opens a search", () => {
		const { result } = render()

		expect(result.current.status).toBe("idle")
		expect(result.current.searchResults).toEqual([])
		expect(driveSearchMock.open).not.toHaveBeenCalled()
	})

	it("opens the cache search once when a query becomes active (focused, foreground, unlocked)", () => {
		const { result } = render()

		act(() => {
			result.current.setSearchQuery("report")
		})

		expect(driveSearchMock.open).toHaveBeenCalledTimes(1)
		expect(driveSearchMock.open.mock.calls[0]?.[0]).toMatchObject({ rootUuid: null, name: "report" })
	})

	it("does not open while the screen is unfocused", () => {
		gates.focused = false

		const { result } = render()

		act(() => {
			result.current.setSearchQuery("report")
		})

		expect(driveSearchMock.open).not.toHaveBeenCalled()
	})

	it("does not open while biometric is locked", () => {
		useAppStore.setState({ biometricUnlocked: null })

		const { result } = render()

		act(() => {
			result.current.setSearchQuery("report")
		})

		expect(driveSearchMock.open).not.toHaveBeenCalled()
	})

	it("does not run cache search in select-mode (type='drive' WITH selectOptions)", () => {
		const selectOptions = {
			type: "single" as const,
			files: true,
			directories: false,
			intention: "select" as const,
			items: [],
			id: "sel-1"
		}

		const { result } = renderHook(() => useDriveSearch({ drivePath: drivePath({ selectOptions }) }))

		act(() => {
			result.current.setSearchQuery("report")
		})

		expect(driveSearchMock.open).not.toHaveBeenCalled()
		expect(result.current.status).toBe("idle")
	})

	it("keeps the search engine open when the query is cleared (warm for instant re-search)", () => {
		const { result } = render()

		act(() => {
			result.current.setSearchQuery("report")
		})

		expect(driveSearchMock.open).toHaveBeenCalledTimes(1)

		act(() => {
			result.current.setSearchQuery("")
		})

		// Clearing returns the UI to idle (the directory listing) but does NOT tear down the SDK
		// search — the engine stays warm so retyping is an in-engine refilter, not a resync restart.
		expect(driveSearchMock.closeActive).not.toHaveBeenCalled()
		expect(result.current.status).toBe("idle")
	})

	it("refilters via setName (no reopen) when retyping after a clear (warm engine)", async () => {
		const { result } = render()

		act(() => {
			result.current.setSearchQuery("report")
		})

		expect(driveSearchMock.open).toHaveBeenCalledTimes(1)

		act(() => {
			result.current.setSearchQuery("")
		})
		act(() => {
			result.current.setSearchQuery("budget")
		})

		await advance(SETCONFIG_DEBOUNCE_MS)

		// The engine stayed open across the clear → one open total; the retype flows through
		// setName, never a second open (which would re-register the sync root + run a resync).
		expect(driveSearchMock.open).toHaveBeenCalledTimes(1)
		expect(driveSearchMock.setName).toHaveBeenLastCalledWith("budget")
	})

	it("closes the search when the target directory changes (real session change)", () => {
		const { result, rerender } = render()

		act(() => {
			result.current.setSearchQuery("report")
		})

		expect(driveSearchMock.open).toHaveBeenCalledTimes(1)

		act(() => {
			rerender({ path: drivePath({ uuid: "other-dir" }) })
		})

		// A different directory is a new search session → the prior engine is torn down.
		expect(driveSearchMock.closeActive).toHaveBeenCalled()
	})

	// AppState socket hygiene: the singleton closes the engine on background (releasing the worker
	// socket). On foreground with a BLANK query there is nothing to search, so the keep-alive latch
	// must NOT reopen a match-everything search (which would re-acquire the socket + run a pointless
	// subtree resync). It reopens only once the user types again.
	it("does not reopen on foreground while the query is blank (no pointless match-everything search)", () => {
		const { result, rerender } = render()

		act(() => {
			result.current.setSearchQuery("report")
		})

		expect(driveSearchMock.open).toHaveBeenCalledTimes(1)

		act(() => {
			result.current.setSearchQuery("")
		})

		// Background → foreground cycle while the query is blank.
		gates.appActive = false
		act(() => {
			rerender({ path: drivePath() })
		})
		gates.appActive = true
		act(() => {
			rerender({ path: drivePath() })
		})

		expect(driveSearchMock.open).toHaveBeenCalledTimes(1)
	})

	// The engine stays warm across a clear (good), but the previous query's rows must NOT linger:
	// retyping a DIFFERENT term should start fresh, not flash the old results until the next snapshot.
	it("does not flash the previous query's results when retyping a different term after a clear", () => {
		const { result } = render()

		act(() => {
			result.current.setSearchQuery("report")
		})

		deliver(snapshot({ results: [fileResult("f1"), fileResult("f2")], total: 2n, live: true }))

		expect(result.current.searchResults.map(i => i.data.uuid)).toEqual(["f1", "f2"])

		act(() => {
			result.current.setSearchQuery("")
		})
		act(() => {
			result.current.setSearchQuery("budget")
		})

		// Before the warm engine delivers a snapshot for "budget", the list is empty (fresh),
		// never the stale "report" rows.
		expect(result.current.searchResults).toEqual([])
	})

	it("debounces query keystrokes into a single setName with the latest term (no reopen)", async () => {
		const { result } = render()

		act(() => {
			result.current.setSearchQuery("a")
		})
		act(() => {
			result.current.setSearchQuery("ab")
		})
		act(() => {
			result.current.setSearchQuery("abc")
		})

		// One open (the first activation); keystrokes flow through setName.
		expect(driveSearchMock.open).toHaveBeenCalledTimes(1)

		await advance(SETCONFIG_DEBOUNCE_MS)

		expect(driveSearchMock.setName).toHaveBeenLastCalledWith("abc")
	})

	// Bug: search active → app backgrounded (singleton closes the search to release the
	// shared socket) → foreground → typing only refiltered via setName, which no-ops on a
	// closed search → no results. Fix: a refilter that finds no live search (setName → false)
	// must REOPEN.
	it("reopens when a keystroke can't refilter a closed search (background recovery)", async () => {
		driveSearchMock.setName.mockResolvedValue(false)

		const { result } = render()

		act(() => {
			result.current.setSearchQuery("a")
		})

		expect(driveSearchMock.open).toHaveBeenCalledTimes(1)

		act(() => {
			result.current.setSearchQuery("ab")
		})

		await advance(SETCONFIG_DEBOUNCE_MS)
		await act(async () => {
			await Promise.resolve()
		})

		// setName returned false (no live search) → the hook bumped the nonce → Effect A reopened.
		expect(driveSearchMock.open).toHaveBeenCalledTimes(2)
	})
})

describe("useDriveSearch — result mapping", () => {
	it("maps dir + file CacheSearchResults to DriveItems and settles immediately when non-empty", () => {
		const { result } = render()

		act(() => {
			result.current.setSearchQuery("x")
		})

		deliver(snapshot({ results: [dirResult("d1"), fileResult("f1")], total: 2n, live: true }))

		expect(result.current.searchResults.map(i => i.data.uuid)).toEqual(["d1", "f1"])
		expect(result.current.searchResults.map(i => i.type)).toEqual(["directory", "file"])
		expect(result.current.status).toBe("settled")
	})

	it("exposes each hit's parentPath via searchResultPaths (keyed by uuid)", () => {
		const { result } = render()

		act(() => {
			result.current.setSearchQuery("x")
		})

		deliver(snapshot({ results: [dirResult("d1", "Documents"), fileResult("f1", "Documents/Work")], total: 2n, live: true }))

		expect(result.current.searchResultPaths.get("d1")).toBe("Documents")
		expect(result.current.searchResultPaths.get("f1")).toBe("Documents/Work")
	})

	it("rebuilds searchResultPaths from each snapshot (path can change between snapshots)", () => {
		const { result } = render()

		act(() => {
			result.current.setSearchQuery("x")
		})

		deliver(snapshot({ results: [fileResult("f1", "Documents")], total: 1n, live: true }))

		expect(result.current.searchResultPaths.get("f1")).toBe("Documents")

		// A later snapshot reports the item under a different parent — the map follows it.
		deliver(snapshot({ results: [fileResult("f1", "Documents/Archive")], total: 1n, live: true }))

		expect(result.current.searchResultPaths.get("f1")).toBe("Documents/Archive")
	})

	it("reports the SDK total even when it exceeds the windowed result count (truncation footer)", () => {
		const { result } = render()

		act(() => {
			result.current.setSearchQuery("x")
		})

		// The window caps at CEILING; the SDK still reports the full match total.
		deliver(snapshot({ results: [fileResult("f1"), fileResult("f2")], total: 1500n, live: true }))

		expect(result.current.searchResults).toHaveLength(2)
		expect(result.current.totalCount).toBe(1500)
	})

	it("reuses the same DriveItem object for an unchanged uuid across snapshots (stable refs)", () => {
		const { result } = render()

		act(() => {
			result.current.setSearchQuery("x")
		})

		deliver(snapshot({ results: [fileResult("f1")], total: 1n, live: true }))

		const first = result.current.searchResults[0]

		deliver(snapshot({ results: [fileResult("f1"), fileResult("f2")], total: 2n, live: true }))

		// f1 is the SAME object (mapCacheRef memo) — only f2 is freshly mapped.
		expect(result.current.searchResults.find(i => i.data.uuid === "f1")).toBe(first)
	})

	// A remote rename preserves the uuid (FileMetadataChanged / FolderMetadataChanged carry the
	// existing uuid). A uuid-only memo would keep showing the stale name; the content signature must
	// re-map the item so the open search reflects the new name.
	it("re-maps a result whose name changed across snapshots (remote rename, stable uuid)", () => {
		const { result } = render()

		act(() => {
			result.current.setSearchQuery("x")
		})

		deliver(snapshot({ results: [fileResult("f1", "", "old.txt")], total: 1n, live: true }))

		expect(result.current.searchResults.map(i => (i.data as { name?: string }).name)).toEqual(["old.txt"])

		// Same uuid, new name — the worker re-queried and re-delivered the renamed item.
		deliver(snapshot({ results: [fileResult("f1", "", "new.txt")], total: 1n, live: true }))

		expect(result.current.searchResults.map(i => (i.data as { name?: string }).name)).toEqual(["new.txt"])
	})
})

describe("useDriveSearch — state machine (warming / settled / background)", () => {
	it("is warming before the first snapshot lands", () => {
		const { result } = render()

		act(() => {
			result.current.setSearchQuery("x")
		})

		expect(result.current.status).toBe("warming")
	})

	it("keeps warming on an empty snapshot inside the grace window, then settles to no-results", async () => {
		const { result } = render()

		act(() => {
			result.current.setSearchQuery("x")
		})

		deliver(snapshot({ results: [], total: 0n, live: true }))

		// Within grace — must NOT flash "no results" (settled).
		expect(result.current.status).toBe("warming")

		await advance(GRACE_MS)

		// Grace elapsed, no resync in flight → genuinely empty.
		expect(result.current.status).toBe("settled")
		expect(result.current.searchResults).toEqual([])
	})

	it("is searching-empty on an empty snapshot while a resync covers the root (past grace)", async () => {
		const { result } = render()

		act(() => {
			result.current.setSearchQuery("x")
		})

		act(() => {
			useDriveSearchStore.getState().setResyncing(true)
		})

		deliver(snapshot({ results: [], total: 0n, live: true }))

		await advance(GRACE_MS)

		// Empty past grace while still resyncing → "no results yet, still searching" (not a bare spinner).
		expect(result.current.status).toBe("searching-empty")
	})

	it("stays warming when a resync finishes empty just before the results snapshot lands", async () => {
		const { result } = render()

		act(() => {
			result.current.setSearchQuery("x")
		})

		// Resync covering the root is in flight; an empty window snapshot lands while indexing.
		act(() => {
			useDriveSearchStore.getState().setResyncing(true)
		})

		deliver(snapshot({ results: [], total: 0n, live: true }))

		await advance(GRACE_MS)

		// Empty past grace while still resyncing → "no results yet, still searching".
		expect(result.current.status).toBe("searching-empty")

		// Resync FINISHES (resyncing -> false) a beat before the converged results snapshot is
		// delivered on the (decoupled) window channel — must NOT flash settled/"no results".
		act(() => {
			useDriveSearchStore.getState().setResyncing(false)
		})

		await advance(GRACE_MS / 2)

		expect(result.current.status).toBe("warming")

		// ...and it still settles once the resync has been quiet for a full grace window (no deadlock).
		await advance(GRACE_MS)

		expect(result.current.status).toBe("settled")
	})

	it("reports background while results exist and a resync is still converging", () => {
		const { result } = render()

		act(() => {
			result.current.setSearchQuery("x")
		})

		act(() => {
			useDriveSearchStore.getState().setResyncing(true)
		})

		deliver(snapshot({ results: [fileResult("f1")], total: 1n, live: true }))

		expect(result.current.status).toBe("background")
	})

	it("hydrates from an empty warming state to settled when the results snapshot arrives", () => {
		const { result } = render()

		act(() => {
			result.current.setSearchQuery("x")
		})

		// First snapshot is empty (cache mid-index) — warming, never "no results".
		deliver(snapshot({ results: [], total: 0n, live: true }))

		expect(result.current.status).toBe("warming")
		expect(result.current.searchResults).toEqual([])

		// Converged results stream in on a later snapshot.
		deliver(snapshot({ results: [fileResult("f1"), dirResult("d1")], total: 2n, live: true }))

		expect(result.current.searchResults.map(i => i.data.uuid)).toEqual(["f1", "d1"])
		expect(result.current.status).toBe("settled")
	})

	it("keeps warming on an empty snapshot while resync-progress heartbeats keep arriving (past grace)", async () => {
		const { result } = render()

		act(() => {
			result.current.setSearchQuery("x")
		})

		deliver(snapshot({ results: [], total: 0n, live: true }))

		// Heartbeats every 250ms (≈ Listing cadence) well past the 400ms grace — each re-arms the
		// grace, so an empty result must NOT flash "no results" mid-index.
		for (let i = 0; i < 4; i++) {
			await advance(250)
			act(() => {
				useDriveSearchStore.getState().bumpResyncProgress()
			})
		}

		expect(result.current.status).toBe("warming")
	})
})

describe("useDriveSearch — terminal + offline", () => {
	it("is offline-incomplete when offline with no matches (never warming-forever)", () => {
		gates.online = false

		const { result } = render()

		act(() => {
			result.current.setSearchQuery("x")
		})

		expect(result.current.status).toBe("offline-incomplete")
	})

	it("is terminal when the snapshot reports the search is no longer live", () => {
		const { result } = render()

		act(() => {
			result.current.setSearchQuery("x")
		})

		deliver(snapshot({ results: [fileResult("f1")], total: 1n, live: false }))

		expect(result.current.status).toBe("terminal")
	})

	it("is terminal when open() rejects", async () => {
		driveSearchMock.open.mockImplementationOnce(async () => {
			throw new Error("createSearch failed")
		})

		const { result } = render()

		act(() => {
			result.current.setSearchQuery("x")
		})

		await act(async () => {
			await Promise.resolve()
		})

		expect(result.current.status).toBe("terminal")
	})

	it("is terminal when no snapshot arrives within the watchdog window", async () => {
		const { result } = render()

		act(() => {
			result.current.setSearchQuery("x")
		})

		await advance(WATCHDOG_MS)

		expect(result.current.status).toBe("terminal")
	})

	it("is terminal when the cache is unavailable", () => {
		const { result } = render()

		act(() => {
			result.current.setSearchQuery("x")
		})

		act(() => {
			useDriveSearchStore.getState().setCacheUnavailable(true)
		})

		expect(result.current.status).toBe("terminal")
	})

	it("is terminal when the active root is deleted", () => {
		const { result } = render()

		act(() => {
			result.current.setSearchQuery("x")
		})

		act(() => {
			useDriveSearchStore.getState().setRootDeleted(true)
		})

		expect(result.current.status).toBe("terminal")
	})

	it("reopens when connectivity is restored while offline-incomplete", () => {
		gates.online = false

		const { result, rerender } = render()

		act(() => {
			result.current.setSearchQuery("x")
		})

		deliver(snapshot({ results: [], total: 0n, live: true }))

		expect(result.current.status).toBe("offline-incomplete")
		expect(driveSearchMock.open).toHaveBeenCalledTimes(1)

		gates.online = true

		act(() => {
			rerender({ path: drivePath() })
		})

		expect(driveSearchMock.open).toHaveBeenCalledTimes(2)
	})
})

describe("useDriveSearch — own-action optimistic patch (Effect D)", () => {
	it("drops, tombstones, and purges selection on an own driveItemRemoved", () => {
		const { result } = render()

		act(() => {
			result.current.setSearchQuery("x")
		})

		deliver(snapshot({ results: [fileResult("f1"), fileResult("f2")], total: 2n, live: true }))

		act(() => {
			events.emit("driveItemRemoved", { uuid: "f1" })
		})

		expect(result.current.searchResults.map(i => i.data.uuid)).toEqual(["f2"])
		expect(removeFromSelection).toHaveBeenCalledWith(["f1"])
	})

	it("keeps a removed item suppressed even if a later snapshot still contains it (tombstone holds)", () => {
		const { result } = render()

		act(() => {
			result.current.setSearchQuery("x")
		})

		deliver(snapshot({ results: [fileResult("f1"), fileResult("f2")], total: 2n, live: true }))

		act(() => {
			events.emit("driveItemRemoved", { uuid: "f1" })
		})

		// Worker hasn't dropped it yet — same membership re-arrives.
		deliver(snapshot({ results: [fileResult("f1"), fileResult("f2")], total: 2n, live: true }))

		expect(result.current.searchResults.map(i => i.data.uuid)).toEqual(["f2"])
	})

	it("un-suppresses via an own driveItemUpdated so the next snapshot re-includes the item (restore)", () => {
		const { result } = render()

		act(() => {
			result.current.setSearchQuery("x")
		})

		deliver(snapshot({ results: [fileResult("f1"), fileResult("f2")], total: 2n, live: true }))

		act(() => {
			events.emit("driveItemRemoved", { uuid: "f1" })
		})

		expect(result.current.searchResults.map(i => i.data.uuid)).toEqual(["f2"])

		// Own restore clears the tombstone (but doesn't re-add a not-present row itself).
		act(() => {
			events.emit("driveItemUpdated", {
				previousUuid: "f1",
				item: { type: "file", data: { uuid: "f1" } } as unknown as DriveItem
			})
		})

		// The worker's converged snapshot now re-includes it (rebuilt in snapshot order).
		deliver(snapshot({ results: [fileResult("f1"), fileResult("f2")], total: 2n, live: true }))

		expect(result.current.searchResults.map(i => i.data.uuid).sort()).toEqual(["f1", "f2"])
	})

	it("replaces a present item in place on an own driveItemUpdated (rotated uuid)", () => {
		const { result } = render()

		act(() => {
			result.current.setSearchQuery("x")
		})

		deliver(snapshot({ results: [fileResult("f1"), fileResult("f2")], total: 2n, live: true }))

		act(() => {
			events.emit("driveItemUpdated", {
				previousUuid: "f1",
				item: { type: "file", data: { uuid: "f1-rotated" } } as unknown as DriveItem
			})
		})

		expect(result.current.searchResults.map(i => i.data.uuid).sort()).toEqual(["f1-rotated", "f2"])
	})
})

describe("useDriveSearch — session-flag reset regressions", () => {
	// Fix A: openError is sticky session state NOT in sessionKey. A foreground/focus re-open
	// re-runs Effect A without changing sessionKey, so the render-phase reset never clears it.
	// The deriveStatus `(openError && !hasSnapshot)` guard must let a successful re-open's
	// snapshot self-heal the terminal state instead of wedging the session forever.
	it("recovers from a transient open failure once a foreground re-open delivers results", async () => {
		driveSearchMock.open.mockImplementationOnce(async () => {
			throw new Error("createSearch failed")
		})

		const { result, rerender } = render()

		act(() => {
			result.current.setSearchQuery("x")
		})

		await act(async () => {
			await Promise.resolve()
		})

		expect(result.current.status).toBe("terminal")

		// Background→foreground cycle: Effect A re-runs (isAppActive is a dep) WITHOUT changing
		// sessionKey, so openError is not cleared — the re-open's snapshot must clear terminal.
		gates.appActive = false
		act(() => {
			rerender({ path: drivePath() })
		})
		gates.appActive = true
		act(() => {
			rerender({ path: drivePath() })
		})

		deliver(snapshot({ results: [fileResult("f1")], total: 1n, live: true }))

		expect(result.current.status).toBe("settled")
		expect(result.current.searchResults.map(i => i.data.uuid)).toEqual(["f1"])
	})

	// Fix D: the stall-ceiling timer's effect deps are [resyncing]. If resyncing stays true
	// across a directory/session change, the effect does NOT re-run and its old timer keeps
	// counting; without the generation guard it would fire setStallCeilingHit(true) into the
	// new session and prematurely collapse it from background to settled.
	it("does not let a stale stall-ceiling timer collapse a new session", async () => {
		const { result, rerender } = render()

		act(() => {
			result.current.setSearchQuery("x")
		})
		act(() => {
			useDriveSearchStore.getState().setResyncing(true)
		})

		deliver(snapshot({ results: [fileResult("f1")], total: 1n, live: true }))

		expect(result.current.status).toBe("background")

		// Most of the stall window elapses (timer still pending).
		await advance(STALL_CEILING_MS - 5_000)

		// Directory change while resyncing stays true → Effect A reopens + bumps generation,
		// but the stall-ceiling effect ([resyncing]) does not re-run; the old timer survives.
		act(() => {
			rerender({ path: drivePath({ uuid: "other-dir" }) })
		})

		deliver(snapshot({ results: [fileResult("f2")], total: 1n, live: true }))

		expect(result.current.status).toBe("background")

		// Cross the original 30s boundary: the stale timer fires but is generation-guarded.
		await advance(6_000)

		expect(result.current.status).toBe("background")
	})
})

describe("useDriveSearch — activity-based timers (slow huge-tree / slow network)", () => {
	// The watchdog re-arms on every resync-progress heartbeat, so a search that is slow but
	// actively LISTING (Listing ticks ~every 200ms in production) must never go terminal —
	// even long past the raw WATCHDOG_MS — as long as progress keeps arriving.
	it("never goes terminal while resync-progress heartbeats keep arriving (no snapshot yet)", async () => {
		const { result } = render()

		act(() => {
			result.current.setSearchQuery("x")
		})

		// A heartbeat every 5s for 30s — twice the 15s watchdog window. Each bump re-arms it.
		for (let i = 0; i < 6; i++) {
			await advance(5_000)
			act(() => {
				useDriveSearchStore.getState().bumpResyncProgress()
			})
		}

		expect(result.current.status).toBe("warming")
	})

	// The stall ceiling re-arms on every heartbeat, so a still-converging search streaming
	// progress keeps showing "background" (its spinner) past STALL_CEILING_MS — it must not
	// prematurely collapse to settled / "no results".
	it("keeps showing background past the stall window while heartbeats keep arriving", async () => {
		const { result } = render()

		act(() => {
			result.current.setSearchQuery("x")
		})
		act(() => {
			useDriveSearchStore.getState().setResyncing(true)
		})

		deliver(snapshot({ results: [fileResult("f1")], total: 1n, live: true }))

		expect(result.current.status).toBe("background")

		// A heartbeat every 10s for 60s — twice the 30s stall window.
		for (let i = 0; i < 6; i++) {
			await advance(10_000)
			act(() => {
				useDriveSearchStore.getState().bumpResyncProgress()
			})
		}

		expect(result.current.status).toBe("background")
	})

	// Review #1: Effect A re-opens (bumping the generation) on focus/foreground/unlock edges.
	// The watchdog effect must re-arm on those same edges, or a search re-opened on foreground
	// that then wedges (never delivers a snapshot) spins "warming" forever.
	it("re-arms the watchdog on a foreground re-open so a wedged re-open still goes terminal", async () => {
		const { result, rerender } = render()

		act(() => {
			result.current.setSearchQuery("x")
		})

		// Background→foreground cycle, no snapshot ever delivered (wedged). Effect A re-opens
		// on the foreground edge with a fresh generation; the watchdog must re-arm for it.
		gates.appActive = false
		act(() => {
			rerender({ path: drivePath() })
		})
		gates.appActive = true
		act(() => {
			rerender({ path: drivePath() })
		})

		await advance(WATCHDOG_MS)

		expect(result.current.status).toBe("terminal")
	})

	// Review #2: a sticky watchdogFired must clear when progress resumes (a Listing heartbeat
	// after a dropped Started, resyncing still false) — otherwise it mis-reports terminal on a
	// visibly-progressing search.
	it("clears a stale watchdog latch when a progress heartbeat resumes", async () => {
		const { result } = render()

		act(() => {
			result.current.setSearchQuery("x")
		})

		await advance(WATCHDOG_MS)

		expect(result.current.status).toBe("terminal")

		// A resync-progress heartbeat (no Started, no snapshot) — the worker is alive again.
		act(() => {
			useDriveSearchStore.getState().bumpResyncProgress()
		})

		expect(result.current.status).toBe("warming")
	})

	// Backstop for a dropped `Finished` (best-effort delivery): an empty result pinned "warming"
	// by `resyncing` must still settle once the stall ceiling trips on total silence — never spin
	// "Searching…" forever. (Re-arming grace doesn't override this: `stallCeilingHit` wins.)
	it("collapses an empty resyncing search to settled after the stall ceiling (dropped Finished)", async () => {
		const { result } = render()

		act(() => {
			result.current.setSearchQuery("x")
		})
		act(() => {
			useDriveSearchStore.getState().setResyncing(true)
		})

		deliver(snapshot({ results: [], total: 0n, live: true }))

		expect(result.current.status).toBe("warming")

		await advance(STALL_CEILING_MS)

		expect(result.current.status).toBe("settled")
		expect(result.current.searchResults).toEqual([])
	})
})
