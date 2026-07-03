// @vitest-environment happy-dom

// Tests for the pure loading/error state helpers used by
// src/features/notes/components/content/index.tsx.
//
// T5: these helpers are IMPORTED from the component module (computeNoteLoading /
//   computeNoteFetchError) — not re-implemented here — so the test actually guards
//   the live derivation. The component calls the exact same functions. The heavy
//   transitive imports of content/index.tsx are stubbed below purely so the module
//   evaluates in the node test runtime; only the two pure helpers are exercised.
//
// Bug #13: noteContentQuery.isError must NOT gate the loading flag —
//   a genuine server error while online must show an error/retry surface,
//   not a permanent blocking spinner.
//
// Bug #38: the loading overlay shows ONLY when there is NOTHING to render yet
//   (initialValue is not a string) AND a fetch is genuinely in flight. The
//   per-note query is deliberately disabled while offline / while inflight
//   content exists, so isPending stays true forever — gating on it alone would
//   spin an eternal spinner over already-rendered content.

import { vi, describe, it, expect, beforeEach } from "vitest"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

const { mockFlushToDisk } = vi.hoisted(() => ({
	mockFlushToDisk: vi.fn()
}))

// @filen/sdk-rs pulls a WASM worker helper that references `self` at import; the component only
// needs the NoteType enum at module-eval, so provide a minimal stand-in.
vi.mock("@filen/sdk-rs", () => ({
	NoteType: {
		Text: "text",
		Md: "md",
		Code: "code",
		Rich: "rich",
		Checklist: "checklist"
	}
}))

vi.mock("react-native-reanimated", () => ({
	FadeOut: {},
	default: {}
}))

vi.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))

vi.mock("uniwind", () => ({
	useResolveClassNames: () => ({ color: "#000" })
}))

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key })
}))

vi.mock("zustand/shallow", () => ({
	useShallow: (selector: unknown) => selector
}))

// Component / store / lib modules that content/index.tsx imports but which the pure helpers
// never touch. Stubbed so the module graph resolves without dragging in their own heavy deps.
vi.mock("@/components/ui/view", () => ({ default: () => null }))
vi.mock("@/components/ui/listEmpty", () => ({ default: () => null }))
vi.mock("@/components/ui/button", () => ({ default: () => null }))
vi.mock("@/components/ui/animated", () => ({ AnimatedView: () => null }))
vi.mock("@/components/textEditor", () => ({ default: () => null }))
vi.mock("@/features/notes/queries/useNoteContent.query", () => ({ default: () => ({}) }))
vi.mock("@/features/notes/queries/useNotesWithContent.query", () => ({ notesWithContentQueryGet: () => null }))
vi.mock("@/features/notes/components/content/checklist", () => ({ default: () => null }))
vi.mock("@/features/notes/utils", () => ({ noteTypeToEditorType: () => "text" }))
vi.mock("@/features/notes/checklistView", () => ({ useChecklistHideCompleted: () => [false] }))
// M3: flushToDisk is the controllable seam — the live flushInflightContentWithAlert helper
// (exported from the component module) is exercised against it. hashNoteContent is a
// deterministic stand-in; buildInflightEntries receives hashes as opaque strings anyway.
vi.mock("@/features/notes/components/sync", () => ({
	sync: { flushToDisk: mockFlushToDisk, clearRejections: vi.fn() },
	hashNoteContent: (content: string) => `h(${content})`
}))
vi.mock("@/lib/auth", () => ({ useStringifiedClient: () => null }))
vi.mock("@/features/notes/store/useNotesInflight.store", () => ({ default: { getState: () => ({ inflightContent: {} }) } }))
vi.mock("@/stores/useTextEditor.store", () => ({ default: () => false }))
vi.mock("@/lib/events", () => ({ default: { subscribe: () => ({ remove: () => {} }) } }))
vi.mock("@/lib/alerts", async () => await import("@/tests/mocks/alerts"))
vi.mock("@/lib/i18n", () => ({
	default: { t: (key: string) => key },
	t: (key: string) => key
}))
vi.mock("@/lib/prompts", () => ({ default: {} }))
vi.mock("@/hooks/useIsOnline", () => ({ default: () => true }))
vi.mock("@filen/utils", async () => ({
	...(await import("@/tests/mocks/filenUtils")),
	runEffect: (fn: (defer: (cleanup: () => void) => void) => void) => {
		const cleanups: (() => void)[] = []

		fn(cleanup => cleanups.push(cleanup))

		return { cleanup: () => cleanups.forEach(c => c()) }
	}
}))

import {
	computeNoteLoading,
	computeNoteFetchError,
	buildInflightEntries,
	flushInflightContentWithAlert
} from "@/features/notes/components/content"
import alerts from "@/lib/alerts"
import { type Note } from "@/types"

// ── #38 — loading requires BOTH (no content yet) AND (fetching/pending) ──────────

describe("computeNoteLoading", () => {
	it("returns false for a history view regardless of query state", () => {
		expect(computeNoteLoading({ history: true, isFetching: true, isPending: true, initialValue: null })).toBe(false)
	})

	it("returns true when fetching AND there is no string content yet", () => {
		expect(computeNoteLoading({ history: false, isFetching: true, isPending: false, initialValue: null })).toBe(true)
	})

	it("returns true when pending AND there is no string content yet", () => {
		expect(computeNoteLoading({ history: false, isFetching: false, isPending: true, initialValue: null })).toBe(true)
	})

	it("returns true when initialValue is undefined and a fetch is in flight", () => {
		expect(computeNoteLoading({ history: false, isFetching: true, isPending: false, initialValue: undefined })).toBe(true)
	})

	it("#38: returns FALSE when content is already available even while fetching (no eternal spinner over rendered content)", () => {
		// The key regression: before the fix, loading was driven by isFetching/isPending
		// alone, so a disabled-query mount (isPending stays true) spun forever even though
		// inflight/list content was on screen. Now a string initialValue suppresses loading.
		expect(computeNoteLoading({ history: false, isFetching: true, isPending: true, initialValue: "rendered" })).toBe(false)
	})

	it("returns false when the query succeeded with a string initialValue", () => {
		expect(computeNoteLoading({ history: false, isFetching: false, isPending: false, initialValue: "hello" })).toBe(false)
	})

	it("returns false for an empty-string initialValue (valid content, editor should render)", () => {
		expect(computeNoteLoading({ history: false, isFetching: false, isPending: false, initialValue: "" })).toBe(false)
	})

	it("returns false when nothing is in flight and there is no content (the error path takes over)", () => {
		// status==='error': isFetching=false, isPending=false, initialValue=null. loading is
		// false now (no fetch in flight); computeNoteFetchError renders the retry surface.
		expect(computeNoteLoading({ history: false, isFetching: false, isPending: false, initialValue: null })).toBe(false)
	})
})

// ── #13 — fetchError flag separates error from loading ───────────────────────────

describe("computeNoteFetchError", () => {
	it("returns false for a history view even when query errored", () => {
		expect(computeNoteFetchError({ history: true, isError: true })).toBe(false)
	})

	it("returns true when not a history view and query errored", () => {
		expect(computeNoteFetchError({ history: false, isError: true })).toBe(true)
	})

	it("returns false when query has not errored", () => {
		expect(computeNoteFetchError({ history: false, isError: false })).toBe(false)
	})

	it("#13: on a query error the error surface shows and the spinner does not", () => {
		// status==='error': isFetching=false, isPending=false, initialValue=null.
		const loading = computeNoteLoading({ history: false, isFetching: false, isPending: false, initialValue: null })
		const fetchError = computeNoteFetchError({ history: false, isError: true })

		expect(fetchError).toBe(true)
		// No fetch in flight → loading is false; the error/retry surface renders via the
		// component's early `if (fetchError)` return regardless.
		expect(loading).toBe(false)
	})
})

// ── M1 + D3 — inflight entry builder (per-note monotonic timestamps + session base) ──────

describe("buildInflightEntries", () => {
	const note = { uuid: "note-1" } as Note

	it("M1: a backward clock step still produces a strictly newer timestamp — the newest text wins and the prune cannot discard it", () => {
		const first = buildInflightEntries({
			previous: undefined,
			note,
			content: "typed-before-step",
			now: 5000,
			sessionBaseHash: null
		})

		// An NTP correction steps the wall clock BACK mid-editing: Date.now() now yields 3000.
		const second = buildInflightEntries({
			previous: first,
			note,
			content: "typed-after-step",
			now: 3000,
			sessionBaseHash: null
		})

		// The newest TEXT carries the strictly-largest timestamp (5001), so sync's
		// max-timestamp pick pushes it — the stale pre-step entry can never outrank it.
		const newest = second.reduce((acc, c) => (c.timestamp > acc.timestamp ? c : acc))

		expect(newest.content).toBe("typed-after-step")
		expect(newest.timestamp).toBe(5001)

		// And after sync pushes it, the `> syncedUpTo` prune (local-vs-local) removes only
		// superseded entries — the newest text was the push, nothing stale resurrects.
		const remainingAfterPrune = second.filter(c => c.timestamp > newest.timestamp)

		expect(remainingAfterPrune).toHaveLength(0)
	})

	it("M1: a forward-moving clock keeps using the wall-clock timestamp", () => {
		const first = buildInflightEntries({ previous: undefined, note, content: "v1", now: 1000, sessionBaseHash: null })
		const second = buildInflightEntries({ previous: first, note, content: "v2", now: 9000, sessionBaseHash: null })

		expect(second[0]!.timestamp).toBe(9000)
		expect(second[0]!.content).toBe("v2")
	})

	it("D3: a fresh session stamps the session base hash onto its first entry", () => {
		const entries = buildInflightEntries({ previous: undefined, note, content: "v1", now: 1000, sessionBaseHash: "h(base)" })

		expect(entries).toHaveLength(1)
		expect(entries[0]!.baseContentHash).toBe("h(base)")
	})

	it("D3: an ongoing session carries ITS base forward even when the session ref moved on", () => {
		const first = buildInflightEntries({ previous: undefined, note, content: "v1", now: 1000, sessionBaseHash: "h(orig)" })
		const second = buildInflightEntries({ previous: first, note, content: "v2", now: 2000, sessionBaseHash: "h(newer)" })

		expect(second[0]!.baseContentHash).toBe("h(orig)")
	})

	it("D3: a legacy session (entries without a hash) stays hash-less — one-pass grace, never mid-session stamping", () => {
		const legacy = [{ timestamp: 1000, content: "restored-from-old-version", note }]
		const next = buildInflightEntries({ previous: legacy, note, content: "v2", now: 2000, sessionBaseHash: "h(now-known)" })

		expect(next[0]!.baseContentHash).toBeUndefined()
	})

	it("D3: a fresh session without a known synced seed records no base (pushes unchecked)", () => {
		const entries = buildInflightEntries({ previous: undefined, note, content: "v1", now: 1000, sessionBaseHash: null })

		expect(entries[0]!.baseContentHash).toBeUndefined()
	})
})

// ── M3 — a failing SQLite flush must surface from the typing path ─────────────────────────

describe("flushInflightContentWithAlert", () => {
	beforeEach(() => {
		mockFlushToDisk.mockReset()
		vi.mocked(alerts.error).mockClear()
	})

	it("alerts when the disk flush reports failure (the edit is memory-only)", async () => {
		mockFlushToDisk.mockResolvedValue(false)

		await flushInflightContentWithAlert()

		expect(alerts.error).toHaveBeenCalledWith("note_edit_not_saved_to_device")
	})

	it("stays silent when the flush succeeds", async () => {
		mockFlushToDisk.mockResolvedValue(true)

		await flushInflightContentWithAlert()

		expect(alerts.error).not.toHaveBeenCalled()
	})
})
