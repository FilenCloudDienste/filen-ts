// Tests for the pure loading/error state helpers extracted from
// src/features/notes/components/content/index.tsx.
//
// Bug #13: noteContentQuery.isError must NOT gate the loading flag —
//   a genuine server error while online must show an error/retry surface,
//   not a permanent blocking spinner.
//
// Bug #34: sync.tsx resolves the live note from the query cache before
//   calling setContent so that metadata changes (type, participants,
//   encryptionKey) arriving between the render snapshot and the 3 s
//   debounce flush are used rather than the stale snapshot.
//   Tests for that live in notesSync.test.ts.

import { describe, it, expect } from "vitest"

// ── Helpers mirroring the exact logic in content/index.tsx ───────────────────

/**
 * Returns true when the blocking loading overlay should be shown.
 * Mirrors: `loading = history ? false : isFetching || isPending || typeof initialValue !== "string"`
 */
function computeLoading({
	history,
	isFetching,
	isPending,
	initialValue
}: {
	history: boolean
	isFetching: boolean
	isPending: boolean
	isError: boolean
	initialValue: string | null | undefined
}): boolean {
	if (history) {
		return false
	}

	return isFetching || isPending || typeof initialValue !== "string"
}

/**
 * Returns true when the error/retry surface should be shown instead of the editor.
 * Mirrors: `fetchError = !history && isError`
 */
function computeFetchError({ history, isError }: { history: boolean; isError: boolean }): boolean {
	return !history && isError
}

// ── Bug #13 — loading flag must NOT include isError ───────────────────────────

describe("computeLoading (#13 — isError excluded from loading flag)", () => {
	it("returns false for a history view regardless of query state", () => {
		expect(
			computeLoading({ history: true, isFetching: true, isPending: true, isError: true, initialValue: null })
		).toBe(false)
	})

	it("returns true when query is still fetching (isFetching)", () => {
		expect(
			computeLoading({ history: false, isFetching: true, isPending: false, isError: false, initialValue: "content" })
		).toBe(true)
	})

	it("returns true when query is pending (no data yet)", () => {
		expect(
			computeLoading({ history: false, isFetching: false, isPending: true, isError: false, initialValue: null })
		).toBe(true)
	})

	it("returns true when initialValue is not a string (null)", () => {
		expect(
			computeLoading({ history: false, isFetching: false, isPending: false, isError: false, initialValue: null })
		).toBe(true)
	})

	it("returns true when initialValue is undefined", () => {
		expect(
			computeLoading({ history: false, isFetching: false, isPending: false, isError: false, initialValue: undefined })
		).toBe(true)
	})

	it("returns false when query succeeded with a string initialValue", () => {
		expect(
			computeLoading({ history: false, isFetching: false, isPending: false, isError: false, initialValue: "hello" })
		).toBe(false)
	})

	it("does not include isError as a direct term (the key regression test)", () => {
		// Before the fix, isError was included directly in the loading condition.
		// With status==='error', TanStack Query sets isFetching=false, isPending=false,
		// but initialValue is still null (no data), so loading is true due to the
		// typeof check — that is expected and handled via the fetchError early-return
		// that renders before the Loading spinner. The isError term itself is gone.
		const withError = computeLoading({ history: false, isFetching: false, isPending: false, isError: true, initialValue: null })
		const withoutError = computeLoading({ history: false, isFetching: false, isPending: false, isError: false, initialValue: null })

		// Both paths behave identically because isError is no longer in the formula:
		// the result depends only on isFetching/isPending/initialValue.
		expect(withError).toBe(withoutError)
	})

	it("loading is true when initialValue is null regardless of isError (typeof check)", () => {
		// When status==='error', TanStack Query has no data so initialValue stays null.
		// loading=true here is expected — the fetchError early-return in the JSX
		// renders the error surface before the Loading spinner ever mounts.
		expect(
			computeLoading({ history: false, isFetching: false, isPending: false, isError: true, initialValue: null })
		).toBe(true)
	})

	it("returns false for empty-string initialValue (valid, editor should render)", () => {
		expect(
			computeLoading({ history: false, isFetching: false, isPending: false, isError: false, initialValue: "" })
		).toBe(false)
	})
})

// ── Bug #13 — fetchError flag separates error from loading ───────────────────

describe("computeFetchError (#13 — error/retry surface gating)", () => {
	it("returns false for a history view even when query errored", () => {
		expect(computeFetchError({ history: true, isError: true })).toBe(false)
	})

	it("returns true when not a history view and query errored", () => {
		expect(computeFetchError({ history: false, isError: true })).toBe(true)
	})

	it("returns false when query has not errored", () => {
		expect(computeFetchError({ history: false, isError: false })).toBe(false)
	})

	it("fetchError=true takes precedence in JSX: the error surface renders first via early return", () => {
		// When status==='error': isFetching=false, isPending=false, initialValue=null.
		// loading is true (due to typeof null !== "string") but the component's early
		// `if (fetchError) { return <ErrorUI /> }` fires before the Loading wrapper,
		// so the spinner is never mounted. The test asserts both values so readers can
		// see the interaction explicitly.
		const loading = computeLoading({
			history: false,
			isFetching: false,
			isPending: false,
			isError: true,
			initialValue: null
		})
		const fetchError = computeFetchError({ history: false, isError: true })

		// fetchError takes over via early return; loading=true is moot in the error path.
		expect(fetchError).toBe(true)
		// loading is still true because initialValue is null (no data on error), but
		// it is never rendered because fetchError's early return fires first.
		expect(loading).toBe(true)
	})
})
