// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest"
import { act, cleanup, renderHook } from "@testing-library/react"
import { useInFlightKeys } from "@/features/contacts/hooks/useInFlightKeys"

afterEach(() => {
	cleanup()
})

describe("useInFlightKeys", () => {
	it("refuses a second claim of a key still in flight, even before a re-render", () => {
		const { result } = renderHook(() => useInFlightKeys())
		const { claim } = result.current
		let first: string[] = []
		let second: string[] = []

		act(() => {
			first = claim(["a"])
			second = claim(["a"])
		})

		expect(first).toEqual(["a"])
		expect(second).toEqual([])
		expect(result.current.inFlight.has("a")).toBe(true)
	})

	it("claims only the keys not already in flight", () => {
		const { result } = renderHook(() => useInFlightKeys())
		let claimed: string[] = []

		act(() => {
			result.current.claim(["a"])
		})
		act(() => {
			claimed = result.current.claim(["a", "b"])
		})

		expect(claimed).toEqual(["b"])
		expect([...result.current.inFlight]).toEqual(["a", "b"])
	})

	it("frees a released key for the next claim", () => {
		const { result } = renderHook(() => useInFlightKeys())
		let again: string[] = []

		act(() => {
			result.current.claim(["a"])
		})
		act(() => {
			result.current.release(["a"])
		})

		expect(result.current.inFlight.size).toBe(0)

		act(() => {
			again = result.current.claim(["a"])
		})

		expect(again).toEqual(["a"])
	})
})
