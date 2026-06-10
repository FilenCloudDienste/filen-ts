import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"

// The real store only needs expo-file-system + the uniffi binding stubbed; everything else it
// imports is type-only (erased) or pure (zustand).
vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))
vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

// screens/transfers.tsx pulls in heavy React + native deps transitively. None of their
// implementations matter for the pure buildTransfersDisplayList builder under test here.
vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))
vi.mock("expo-router", () => ({ router: {} }))
vi.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: vi.fn(() => ({ top: 0, bottom: 0, left: 0, right: 0 }))
}))
vi.mock("uniwind", () => ({ useResolveClassNames: vi.fn(() => ({})) }))
vi.mock("react-i18next", () => ({
	useTranslation: vi.fn(() => ({ t: (k: string) => k }))
}))
vi.mock("@filen/utils", () => ({ run: vi.fn() }))
vi.mock("@filen/sdk-rs", () => ({ DirColor: { Default: { new: vi.fn(() => ({})) } } }))
vi.mock("@/lib/decryption", () => ({ driveItemDisplayName: vi.fn(() => "") }))
vi.mock("@/lib/prompts", () => ({ default: { alert: vi.fn() } }))
vi.mock("@/lib/alerts", () => ({ default: { error: vi.fn() } }))
vi.mock("@/features/transfers/transfers", () => ({ default: { cancelAll: vi.fn() } }))
vi.mock("@/components/ui/text", () => ({ default: "Text" }))
vi.mock("@/components/ui/safeAreaView", () => ({ default: "SafeAreaView" }))
vi.mock("@/components/ui/listEmpty", () => ({ default: "ListEmpty" }))
vi.mock("@/components/ui/header", () => ({ default: "Header" }))
vi.mock("@/components/ui/virtualList", () => ({ default: "VirtualList" }))
vi.mock("@/components/ui/view", () => ({ default: "View", CrossGlassContainerView: "CrossGlassContainerView" }))
vi.mock("@/components/ui/pressables", () => ({ PressableScale: "PressableScale" }))
vi.mock("@/components/ui/menu", () => ({ default: "Menu" }))
vi.mock("@/components/itemIcons", () => ({ DirectoryIcon: "DirectoryIcon", FileIcon: "FileIcon" }))
vi.mock("@/features/drive/components/item/thumbnail", () => ({ default: "Thumbnail" }))
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: "Ionicons" }))

import { useTransfersStore, MAX_FINISHED_TRANSFERS, type Transfer, type FinishedTransfer } from "@/features/transfers/store/useTransfers.store"
import { buildTransfersDisplayList, finishedTransferSubtitle } from "@/features/transfers/screens/transfers"
import { type TFunction } from "i18next"

function makeFinished(id: string, finishedAt: number, overrides: Partial<FinishedTransfer> = {}): FinishedTransfer {
	return {
		id,
		type: "uploadFile",
		name: `file-${id}`,
		size: 1000,
		bytesTransferred: 1000,
		startedAt: finishedAt - 500,
		finishedAt,
		outcome: "succeeded",
		errorMessage: null,
		errorCount: 0,
		...overrides
	}
}

function makeActiveTransfer(id: string, startedAt: number): Transfer {
	return {
		id,
		size: 1000,
		bytesTransferred: 0,
		startedAt,
		paused: false,
		type: "uploadFile",
		errors: { upload: [], scan: [], unknown: [] },
		localFileOrDir: { name: `file-${id}` },
		parent: {}
	} as unknown as Transfer
}

function resetStore(): void {
	useTransfersStore.setState({
		transfers: [],
		finishedTransfers: [],
		stats: { progress: 0, speed: 0, count: 0 }
	})
	// Run the public setter once so the speed interval / samples buffer are torn down.
	useTransfersStore.getState().setTransfers([])
}

describe("finished transfers store", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
		resetStore()
	})

	afterEach(() => {
		resetStore()
		vi.useRealTimers()
	})

	describe("addFinishedTransfer", () => {
		it("appends in insertion order", () => {
			useTransfersStore.getState().addFinishedTransfer(makeFinished("a", 100))
			useTransfersStore.getState().addFinishedTransfer(makeFinished("b", 200))
			useTransfersStore.getState().addFinishedTransfer(makeFinished("c", 300))

			expect(useTransfersStore.getState().finishedTransfers.map(f => f.id)).toEqual(["a", "b", "c"])
		})

		it("caps at MAX_FINISHED_TRANSFERS by dropping the oldest entries", () => {
			for (let i = 0; i < MAX_FINISHED_TRANSFERS + 5; i++) {
				useTransfersStore.getState().addFinishedTransfer(makeFinished(`id-${i}`, i))
			}

			const finished = useTransfersStore.getState().finishedTransfers

			expect(finished).toHaveLength(MAX_FINISHED_TRANSFERS)
			// The 5 oldest (id-0 … id-4) were dropped; the newest is the last appended.
			expect(finished[0]?.id).toBe("id-5")
			expect(finished[finished.length - 1]?.id).toBe(`id-${MAX_FINISHED_TRANSFERS + 4}`)
		})

		it("keeps exactly the cap when filled to the boundary, no drops", () => {
			for (let i = 0; i < MAX_FINISHED_TRANSFERS; i++) {
				useTransfersStore.getState().addFinishedTransfer(makeFinished(`id-${i}`, i))
			}

			expect(useTransfersStore.getState().finishedTransfers).toHaveLength(MAX_FINISHED_TRANSFERS)
			expect(useTransfersStore.getState().finishedTransfers[0]?.id).toBe("id-0")
		})
	})

	describe("removeFinishedTransfer", () => {
		it("removes the matching entry only", () => {
			useTransfersStore.getState().addFinishedTransfer(makeFinished("a", 100))
			useTransfersStore.getState().addFinishedTransfer(makeFinished("b", 200))
			useTransfersStore.getState().addFinishedTransfer(makeFinished("c", 300))

			useTransfersStore.getState().removeFinishedTransfer("b")

			expect(useTransfersStore.getState().finishedTransfers.map(f => f.id)).toEqual(["a", "c"])
		})

		it("is a no-op when the id is unknown", () => {
			useTransfersStore.getState().addFinishedTransfer(makeFinished("a", 100))

			useTransfersStore.getState().removeFinishedTransfer("does-not-exist")

			expect(useTransfersStore.getState().finishedTransfers.map(f => f.id)).toEqual(["a"])
		})
	})

	describe("clearFinishedTransfers", () => {
		it("empties the finished list", () => {
			useTransfersStore.getState().addFinishedTransfer(makeFinished("a", 100))
			useTransfersStore.getState().addFinishedTransfer(makeFinished("b", 200))

			useTransfersStore.getState().clearFinishedTransfers()

			expect(useTransfersStore.getState().finishedTransfers).toEqual([])
		})

		it("returns the same state reference when already empty (no churn)", () => {
			const before = useTransfersStore.getState().finishedTransfers

			useTransfersStore.getState().clearFinishedTransfers()

			expect(useTransfersStore.getState().finishedTransfers).toBe(before)
		})
	})

	describe("isolation from active transfers + stats", () => {
		it("finished mutations do not touch the active transfers array", () => {
			useTransfersStore.getState().setTransfers([makeActiveTransfer("active-1", 50)])
			const activeBefore = useTransfersStore.getState().transfers

			useTransfersStore.getState().addFinishedTransfer(makeFinished("done-1", 100))
			useTransfersStore.getState().removeFinishedTransfer("done-1")
			useTransfersStore.getState().addFinishedTransfer(makeFinished("done-2", 200))
			useTransfersStore.getState().clearFinishedTransfers()

			// Same reference: none of the finished actions reallocated or filtered `transfers`.
			expect(useTransfersStore.getState().transfers).toBe(activeBefore)
		})

		it("finished mutations do not recompute stats", () => {
			useTransfersStore.getState().setTransfers([makeActiveTransfer("active-1", 50)])
			const statsBefore = useTransfersStore.getState().stats

			useTransfersStore.getState().addFinishedTransfer(makeFinished("done-1", 100))
			useTransfersStore.getState().addFinishedTransfer(makeFinished("done-2", 200))
			useTransfersStore.getState().clearFinishedTransfers()

			// stats is the same object: addFinishedTransfer/clearFinishedTransfers never call updateTransfers.
			expect(useTransfersStore.getState().stats).toBe(statsBefore)
		})

		it("stats.count stays scoped to active transfers, ignoring finished entries", () => {
			useTransfersStore.getState().setTransfers([makeActiveTransfer("active-1", 50)])
			useTransfersStore.getState().addFinishedTransfer(makeFinished("done-1", 100))
			useTransfersStore.getState().addFinishedTransfer(makeFinished("done-2", 200))

			expect(useTransfersStore.getState().stats.count).toBe(1)
		})
	})
})

describe("buildTransfersDisplayList", () => {
	it("places active transfers on top ordered by startedAt ascending", () => {
		const result = buildTransfersDisplayList({
			transfers: [makeActiveTransfer("c", 300), makeActiveTransfer("a", 100), makeActiveTransfer("b", 200)],
			finishedTransfers: []
		})

		expect(result.map(item => (item.kind === "active" ? item.transfer.id : item.finished.id))).toEqual(["a", "b", "c"])
	})

	it("places finished transfers below active ones, ordered by finishedAt descending", () => {
		const result = buildTransfersDisplayList({
			transfers: [],
			finishedTransfers: [makeFinished("old", 100), makeFinished("newest", 300), makeFinished("mid", 200)]
		})

		expect(result.map(item => (item.kind === "finished" ? item.finished.id : item.transfer.id))).toEqual(["newest", "mid", "old"])
	})

	it("merges both: active (startedAt asc) first, then finished (finishedAt desc)", () => {
		const result = buildTransfersDisplayList({
			transfers: [makeActiveTransfer("act-late", 200), makeActiveTransfer("act-early", 100)],
			finishedTransfers: [makeFinished("fin-old", 100), makeFinished("fin-new", 400)]
		})

		expect(result.map(item => (item.kind === "active" ? `active:${item.transfer.id}` : `finished:${item.finished.id}`))).toEqual([
			"active:act-early",
			"active:act-late",
			"finished:fin-new",
			"finished:fin-old"
		])
	})

	it("does not mutate its input arrays", () => {
		const transfers = [makeActiveTransfer("b", 200), makeActiveTransfer("a", 100)]
		const finishedTransfers = [makeFinished("y", 100), makeFinished("z", 300)]
		const transfersCopy = [...transfers]
		const finishedCopy = [...finishedTransfers]

		buildTransfersDisplayList({ transfers, finishedTransfers })

		expect(transfers).toEqual(transfersCopy)
		expect(finishedTransfers).toEqual(finishedCopy)
	})
})

describe("finishedTransferSubtitle", () => {
	// A t spy that records key + params so plural/count interpolation can be asserted.
	const makeT = () => {
		const calls: { key: string; params: Record<string, unknown> | undefined }[] = []
		const t = ((key: string, params?: Record<string, unknown>) => {
			calls.push({ key, params })

			return params ? `${key}:${JSON.stringify(params)}` : key
		}) as unknown as TFunction

		return { t, calls }
	}

	it("renders the captured error message for an errored transfer", () => {
		const { t } = makeT()
		const finished = makeFinished("a", 100, { outcome: "errored", errorMessage: "boom" })

		expect(finishedTransferSubtitle(finished, t)).toBe("boom")
	})

	it("falls back to transfer_failed for an errored transfer without a message", () => {
		const { t } = makeT()
		const finished = makeFinished("a", 100, { outcome: "errored", errorMessage: null })

		expect(finishedTransferSubtitle(finished, t)).toBe("transfer_failed")
	})

	it("renders the localized error count for a completedWithErrors transfer (C1 settle honesty)", () => {
		const { t, calls } = makeT()
		const finished = makeFinished("a", 100, { outcome: "completedWithErrors", errorCount: 3 })

		expect(finishedTransferSubtitle(finished, t)).toBe('transfer_completed_with_errors:{"count":3}')
		expect(calls).toEqual([{ key: "transfer_completed_with_errors", params: { count: 3 } }])
	})

	it("renders transfer_completed for a clean success", () => {
		const { t } = makeT()
		const finished = makeFinished("a", 100, { outcome: "succeeded" })

		expect(finishedTransferSubtitle(finished, t)).toBe("transfer_completed")
	})
})
