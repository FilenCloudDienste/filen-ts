import { describe, expect, it } from "vitest"
import { publicLinkState, isPasswordError, type PublicLinkResource } from "@/features/publicLinks/lib/state.logic"

const fileResource: PublicLinkResource = { kind: "file", name: "photo.jpg", size: 1024n, category: "image" }
const dirResource: PublicLinkResource = { kind: "directory", name: "My folder" }

describe("publicLinkState", () => {
	it("maps a pending query to the loading state", () => {
		expect(publicLinkState({ status: "pending", data: undefined, error: undefined })).toEqual({ status: "loading" })
	})

	it("maps a plain error to the invalid state", () => {
		expect(publicLinkState({ status: "error", data: undefined, error: { kind: "notFound", label: "not found", message: "" } })).toEqual(
			{
				status: "invalid"
			}
		)
	})

	it("maps a password-looking error to the password state", () => {
		expect(
			publicLinkState({ status: "error", data: undefined, error: { kind: "wrongPassword", label: "Wrong password", message: "" } })
		).toEqual({ status: "password" })
	})

	it("maps a resolved file to the ready state carrying the resource", () => {
		expect(publicLinkState({ status: "success", data: fileResource, error: undefined })).toEqual({
			status: "ready",
			resource: fileResource
		})
	})

	it("maps a resolved directory to the ready state carrying the resource", () => {
		expect(publicLinkState({ status: "success", data: dirResource, error: undefined })).toEqual({
			status: "ready",
			resource: dirResource
		})
	})

	it("maps a directory's up-front password flag (a password resource) to the password state", () => {
		expect(publicLinkState({ status: "success", data: { kind: "password" }, error: undefined })).toEqual({ status: "password" })
	})

	it("treats a success with no data as invalid (defensive)", () => {
		expect(publicLinkState({ status: "success", data: undefined, error: undefined })).toEqual({ status: "invalid" })
	})
})

describe("isPasswordError", () => {
	it("detects 'password' anywhere in the error's kind/label/message (case-insensitive)", () => {
		expect(isPasswordError({ label: "This link requires a PASSWORD" })).toBe(true)
		expect(isPasswordError({ kind: "linkPasswordRequired" })).toBe(true)
	})

	it("is false for an unrelated error", () => {
		expect(isPasswordError({ kind: "notFound", label: "This link does not exist" })).toBe(false)
	})

	it("is false for a non-object error", () => {
		expect(isPasswordError("boom")).toBe(false)
		expect(isPasswordError(null)).toBe(false)
	})
})
