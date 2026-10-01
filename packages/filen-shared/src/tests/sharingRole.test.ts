import { describe, it, expect } from "vitest"
import { shareIdentityFromRole, shareRoleKind } from "@filen/shared"

describe("shareIdentityFromRole", () => {
	it("returns null when the role is absent", () => {
		expect(shareIdentityFromRole(undefined)).toBeNull()
	})

	it("reads the wasm runtime's internally tagged shape", () => {
		expect(shareIdentityFromRole({ type: "sharer", id: 5, email: "flat@filen.io" })).toEqual({ userId: 5n, email: "flat@filen.io" })
		expect(shareIdentityFromRole({ type: "receiver", id: 6n, email: "flat-out@filen.io" })).toEqual({
			userId: 6n,
			email: "flat-out@filen.io"
		})
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

describe("shareRoleKind", () => {
	it("returns null when the role is absent or unreadable", () => {
		expect(shareRoleKind(undefined)).toBeNull()
		expect(shareRoleKind({})).toBeNull()
	})

	it("reads the wasm runtime's type tag", () => {
		expect(shareRoleKind({ type: "sharer", id: 1, email: "a@filen.io" })).toBe("sharer")
		expect(shareRoleKind({ type: "receiver", id: 1, email: "a@filen.io" })).toBe("receiver")
	})

	it("reads the uniffi runtime's tag", () => {
		expect(shareRoleKind({ tag: "Sharer", inner: [{ id: 1, email: "a@filen.io" }] })).toBe("sharer")
		expect(shareRoleKind({ tag: "Receiver", inner: [{ id: 1, email: "a@filen.io" }] })).toBe("receiver")
	})

	it("reads the .d.ts shape", () => {
		expect(shareRoleKind({ Sharer: { id: 1, email: "a@filen.io" } })).toBe("sharer")
		expect(shareRoleKind({ Receiver: { id: 1, email: "a@filen.io" } })).toBe("receiver")
	})
})
