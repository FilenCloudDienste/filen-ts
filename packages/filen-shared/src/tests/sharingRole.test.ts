import { describe, it, expect } from "vitest"
import { shareIdentityFromRole } from "@filen/shared"

describe("shareIdentityFromRole", () => {
	it("returns null when the role is absent", () => {
		expect(shareIdentityFromRole(undefined)).toBeNull()
	})

	it("reads the wasm-surface Sharer shape (number id)", () => {
		expect(shareIdentityFromRole({ Sharer: { id: 1, email: "sharer@filen.io" } })).toEqual({ userId: 1n, email: "sharer@filen.io" })
	})

	it("reads the wasm-surface Receiver shape (bigint id)", () => {
		expect(shareIdentityFromRole({ Receiver: { id: 2n, email: "receiver@filen.io" } })).toEqual({
			userId: 2n,
			email: "receiver@filen.io"
		})
	})

	it("reads the uniffi-runtime {inner:[…]} shape ahead of Sharer/Receiver", () => {
		expect(
			shareIdentityFromRole({
				inner: [{ id: 3, email: "runtime@filen.io" }],
				Sharer: { id: 999, email: "ignored@filen.io" }
			})
		).toEqual({ userId: 3n, email: "runtime@filen.io" })
	})

	it("falls back to Sharer/Receiver when inner is empty", () => {
		expect(shareIdentityFromRole({ inner: [], Receiver: { id: 4n, email: "fallback@filen.io" } })).toEqual({
			userId: 4n,
			email: "fallback@filen.io"
		})
	})

	it("returns null when no known shape carries an identity", () => {
		expect(shareIdentityFromRole({})).toBeNull()
	})
})
