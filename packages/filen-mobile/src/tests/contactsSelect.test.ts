// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach } from "vitest"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
	searchParams: {} as Record<string, string | undefined>
}))

vi.mock("expo-router", () => ({
	useLocalSearchParams: () => mocks.searchParams,
	router: {
		push: vi.fn()
	}
}))

vi.mock("expo-crypto", () => ({
	randomUUID: () => "test-uuid-1234"
}))

vi.mock("@/lib/events", () => ({
	default: {
		subscribe: vi.fn(() => ({ remove: vi.fn() })),
		emit: vi.fn()
	}
}))

vi.mock("@/features/contacts/store/useContacts.store", () => ({
	default: {
		getState: () => ({
			clearSelectedContacts: vi.fn()
		})
	}
}))

// ─── Imports ─────────────────────────────────────────────────────────────────

import { renderHook } from "@testing-library/react"
import { useSelectOptions } from "@/features/contacts/contactsSelect"
import { serialize } from "@/lib/serializer"
import type { SelectOptions } from "@/features/contacts/contactsSelect"

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
	mocks.searchParams = {}
})

// ─── useSelectOptions ─────────────────────────────────────────────────────────

describe("useSelectOptions", () => {
	it("returns null when no selectOptions param is present", () => {
		mocks.searchParams = {}

		const { result } = renderHook(() => useSelectOptions())

		expect(result.current).toBeNull()
	})

	it("returns null when selectOptions param is undefined", () => {
		mocks.searchParams = { selectOptions: undefined }

		const { result } = renderHook(() => useSelectOptions())

		expect(result.current).toBeNull()
	})

	it("returns null when selectOptions param is an empty string", () => {
		mocks.searchParams = { selectOptions: "" }

		const { result } = renderHook(() => useSelectOptions())

		expect(result.current).toBeNull()
	})

	it("returns parsed SelectOptions when a valid serialized value is provided", () => {
		const opts: SelectOptions = {
			id: "abc-123",
			userIdsToExclude: [1, 2, 3]
		}

		mocks.searchParams = { selectOptions: serialize(opts) }

		const { result } = renderHook(() => useSelectOptions())

		expect(result.current).not.toBeNull()
		expect(result.current?.id).toBe("abc-123")
		expect(result.current?.userIdsToExclude).toEqual([1, 2, 3])
	})

	it("returns null (does not throw) when selectOptions is malformed/non-JSON", () => {
		mocks.searchParams = { selectOptions: "!!!not-valid-json!!!" }

		const { result } = renderHook(() => useSelectOptions())

		expect(result.current).toBeNull()
	})

	it("returns null (does not throw) when selectOptions is truncated/corrupt base64", () => {
		mocks.searchParams = { selectOptions: "{broken" }

		const { result } = renderHook(() => useSelectOptions())

		expect(result.current).toBeNull()
	})

	it("strips extra fields — only id and userIdsToExclude are returned", () => {
		const rawWithExtras = {
			id: "strip-test",
			userIdsToExclude: [99],
			extraField: "should-not-appear",
			anotherExtra: 42
		}

		mocks.searchParams = { selectOptions: serialize(rawWithExtras) }

		const { result } = renderHook(() => useSelectOptions())

		expect(result.current).not.toBeNull()
		expect(result.current?.id).toBe("strip-test")
		expect(result.current?.userIdsToExclude).toEqual([99])
		// Extra fields must not leak through
		expect((result.current as unknown as Record<string, unknown>)?.["extraField"]).toBeUndefined()
		expect((result.current as unknown as Record<string, unknown>)?.["anotherExtra"]).toBeUndefined()
	})

	it("returns undefined userIdsToExclude when none were passed", () => {
		const opts: SelectOptions = {
			id: "no-excludes"
		}

		mocks.searchParams = { selectOptions: serialize(opts) }

		const { result } = renderHook(() => useSelectOptions())

		expect(result.current?.id).toBe("no-excludes")
		expect(result.current?.userIdsToExclude).toBeUndefined()
	})

	it("returned object contains exactly two keys: id, userIdsToExclude", () => {
		const opts: SelectOptions = {
			id: "key-count-test",
			userIdsToExclude: [5]
		}

		mocks.searchParams = { selectOptions: serialize(opts) }

		const { result } = renderHook(() => useSelectOptions())

		const keys = Object.keys(result.current as object)

		expect(keys).toHaveLength(2)
		expect(keys).toContain("id")
		expect(keys).toContain("userIdsToExclude")
	})
})
