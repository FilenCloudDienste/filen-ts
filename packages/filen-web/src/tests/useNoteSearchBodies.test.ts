// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { onlineManager } from "@tanstack/react-query"
import type { Note } from "@filen/sdk-rs"

const { getNoteContent } = vi.hoisted(() => ({ getNoteContent: vi.fn<(note: Note) => Promise<string | undefined>>() }))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { getNoteContent } }))
vi.mock("@/queries/client", async () => ({ queryClient: (await import("@/tests/testQueryClient")).createTestQueryClient() }))
vi.mock("@/features/notes/lib/sync", () => ({ sync: {} }))

import { queryClient } from "@/queries/client"
import { queryClientWrapper } from "@/tests/testQueryClient"
import { noteSearchBodyCandidates, buildNoteBodiesMap } from "@/features/notes/hooks/useNoteSearchBodies.logic"
import { noteSearchEmptyState, useNoteSearchBodies } from "@/features/notes/hooks/useNoteSearchBodies"
import { useNotesInflightStore } from "@/features/notes/store/useNotesInflight"
import { filterNotesBySearch } from "@/features/notes/lib/sort"
import { testUuid } from "@/tests/support/uuid"
import { mockNote, undecryptableNote } from "@/tests/fixtures/notes"

describe("noteSearchBodyCandidates", () => {
	it("returns no candidates at all for a blank query — the whole opt-in gate", () => {
		const notes = [mockNote({ uuid: testUuid("a"), title: "Groceries" })]

		expect(noteSearchBodyCandidates(notes, "")).toEqual([])
		expect(noteSearchBodyCandidates(notes, "   ")).toEqual([])
	})

	it("excludes a note whose title already matches — its body never needs fetching", () => {
		const titleMatch = mockNote({ uuid: testUuid("title-match"), title: "Quarterly Report" })
		const titleMiss = mockNote({ uuid: testUuid("title-miss"), title: "Unrelated" })

		expect(noteSearchBodyCandidates([titleMatch, titleMiss], "quarterly")).toEqual([titleMiss])
	})

	it("includes every note when no title matches at all", () => {
		const a = mockNote({ uuid: testUuid("a"), title: "Alpha" })
		const b = mockNote({ uuid: testUuid("b"), title: "Beta" })

		expect(noteSearchBodyCandidates([a, b], "zzz")).toEqual([a, b])
	})

	it("excludes an undecryptable note — its body read can only fail, so it searches its preview", () => {
		const locked = undecryptableNote({ uuid: testUuid("locked") })
		const readable = mockNote({ uuid: testUuid("readable"), title: "Unrelated" })

		expect(noteSearchBodyCandidates([locked, readable], "zzz")).toEqual([readable])
	})
})

describe("buildNoteBodiesMap", () => {
	it("zips candidates to their positionally-parallel fetched bodies", () => {
		const a = mockNote({ uuid: testUuid("a") })
		const b = mockNote({ uuid: testUuid("b") })

		const map = buildNoteBodiesMap([a, b], ["body a", "body b"])

		expect(map.get(testUuid("a"))).toBe("body a")
		expect(map.get(testUuid("b"))).toBe("body b")
	})

	it("keeps a still-in-flight fetch's slot as undefined rather than dropping the entry", () => {
		const a = mockNote({ uuid: testUuid("a") })

		const map = buildNoteBodiesMap([a], [undefined])

		expect(map.has(testUuid("a"))).toBe(true)
		expect(map.get(testUuid("a"))).toBeUndefined()
	})

	it("returns an empty map for no candidates", () => {
		expect(buildNoteBodiesMap([], [])).toEqual(new Map())
	})
})

describe("useNoteSearchBodies pending and failed counts", () => {
	const wrapper = queryClientWrapper(queryClient)
	const a = mockNote({ uuid: testUuid("count-a"), title: "Alpha" })
	const b = mockNote({ uuid: testUuid("count-b"), title: "Beta" })

	beforeEach(() => {
		queryClient.clear()
		getNoteContent.mockReset()
	})

	afterEach(() => {
		onlineManager.setOnline(true)
	})

	it("counts nothing outside a search", () => {
		const { result } = renderHook(() => useNoteSearchBodies([a, b], ""), { wrapper })

		expect(result.current).toEqual({ bodies: new Map(), pending: 0, failed: 0 })
		expect(getNoteContent).not.toHaveBeenCalled()
	})

	it("counts a fetching body as pending, then as searched once it lands", async () => {
		let resolve: (value: string) => void = () => undefined
		getNoteContent.mockImplementation(note =>
			note.uuid === a.uuid ? new Promise(res => (resolve = res)) : Promise.resolve("Beta Body")
		)

		const { result } = renderHook(() => useNoteSearchBodies([a, b], "zzz"), { wrapper })

		await waitFor(() => {
			expect(result.current.bodies.get(b.uuid)).toBe("beta body")
		})
		expect(result.current.pending).toBe(1)
		expect(result.current.failed).toBe(0)

		act(() => {
			resolve("Alpha Body")
		})

		await waitFor(() => {
			expect(result.current.pending).toBe(0)
		})
		expect(result.current.failed).toBe(0)
		expect(result.current.bodies.get(a.uuid)).toBe("alpha body")
	})

	it("counts an errored body read as failed, not pending", async () => {
		getNoteContent.mockImplementation(note =>
			note.uuid === a.uuid ? Promise.reject(new Error("read failed")) : Promise.resolve("beta")
		)

		const { result } = renderHook(() => useNoteSearchBodies([a, b], "zzz"), { wrapper })

		await waitFor(() => {
			expect(result.current.failed).toBe(1)
		})
		expect(result.current.pending).toBe(0)
	})

	it("counts a paused (offline) body read as failed so the searching state ends", () => {
		onlineManager.setOnline(false)
		getNoteContent.mockResolvedValue("body")

		const { result } = renderHook(() => useNoteSearchBodies([a, b], "zzz"), { wrapper })

		expect(result.current.pending).toBe(0)
		expect(result.current.failed).toBe(2)
		expect(getNoteContent).not.toHaveBeenCalled()
	})

	it("never counts a note being edited: it is not a candidate", () => {
		onlineManager.setOnline(false)
		useNotesInflightStore.setState({ editingSessions: { [a.uuid]: true } })

		try {
			const { result } = renderHook(() => useNoteSearchBodies([a, b], "zzz"), { wrapper })

			expect(result.current.failed).toBe(1)
			expect(result.current.bodies.has(a.uuid)).toBe(false)
		} finally {
			useNotesInflightStore.setState({ editingSessions: {} })
		}
	})

	// The producer's fold must be the search key's own: a decomposed body (typed on macOS) matches a
	// composed query once loaded, agreeing with the preview fallback used while it loads.
	it("folds a decomposed body so filterNotesBySearch matches a composed query", async () => {
		const decomposed = "Meeting: Übersicht".normalize("NFD")
		const note = mockNote({ uuid: testUuid("fold-nfd"), title: "Untitled", preview: decomposed })

		getNoteContent.mockResolvedValue(decomposed)

		const { result } = renderHook(() => useNoteSearchBodies([note], "übersicht"), { wrapper })

		await waitFor(() => {
			expect(result.current.bodies.get(note.uuid)).toBeDefined()
		})
		expect(filterNotesBySearch([note], "übersicht", result.current.bodies)).toEqual([note])
		expect(filterNotesBySearch([note], "übersicht")).toEqual([note])
	})
})

describe("noteSearchEmptyState", () => {
	it("is searching while any body is pending, even with failures", () => {
		expect(noteSearchEmptyState({ pending: 1, failed: 2 })).toBe("searching")
	})

	it("is unsearched when nothing is pending but some bodies were not read", () => {
		expect(noteSearchEmptyState({ pending: 0, failed: 1 })).toBe("unsearched")
	})

	it("is a real empty result only when every candidate body was searched", () => {
		expect(noteSearchEmptyState({ pending: 0, failed: 0 })).toBe("empty")
	})
})
