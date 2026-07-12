import { describe, expect, it } from "vitest"
import type { DirPublicInfo } from "@filen/sdk-rs"
import { fileAccessState, dirAccessState, linkForBrowsing } from "@/features/publicLinks/lib/password.logic"

const passwordError = { kind: "wrongPassword", label: "Wrong password", message: "" }
const deadLinkError = { kind: "notFound", label: "not found", message: "" }

describe("fileAccessState", () => {
	it("is loading on the first pending resolve, before any submit", () => {
		expect(fileAccessState({ status: "pending", error: undefined, submitted: false })).toBe("loading")
	})

	it("is checking on a pending resolve after a submit", () => {
		expect(fileAccessState({ status: "pending", error: undefined, submitted: true })).toBe("checking")
	})

	it("prompts on a password error before a submit", () => {
		expect(fileAccessState({ status: "error", error: passwordError, submitted: false })).toBe("prompt")
	})

	it("reports wrong on a password error after a submit", () => {
		expect(fileAccessState({ status: "error", error: passwordError, submitted: true })).toBe("wrong")
	})

	it("routes a non-password error to the invalid surface", () => {
		expect(fileAccessState({ status: "error", error: deadLinkError, submitted: false })).toBe("error")
		expect(fileAccessState({ status: "error", error: deadLinkError, submitted: true })).toBe("error")
	})

	it("is ready on success", () => {
		expect(fileAccessState({ status: "success", error: undefined, submitted: true })).toBe("ready")
	})
})

describe("dirAccessState", () => {
	it("is loading while info resolves", () => {
		expect(dirAccessState({ infoStatus: "pending", hasPassword: false, accepted: false, verifying: false, failed: false })).toBe(
			"loading"
		)
	})

	it("routes an info error to the invalid surface", () => {
		expect(dirAccessState({ infoStatus: "error", hasPassword: false, accepted: false, verifying: false, failed: false })).toBe("error")
	})

	it("is ready immediately for an unprotected link", () => {
		expect(dirAccessState({ infoStatus: "success", hasPassword: false, accepted: false, verifying: false, failed: false })).toBe(
			"ready"
		)
	})

	it("prompts for a protected link before acceptance", () => {
		expect(dirAccessState({ infoStatus: "success", hasPassword: true, accepted: false, verifying: false, failed: false })).toBe(
			"prompt"
		)
	})

	it("is checking while a candidate password verifies", () => {
		expect(dirAccessState({ infoStatus: "success", hasPassword: true, accepted: false, verifying: true, failed: false })).toBe(
			"checking"
		)
	})

	it("reports wrong after a failed verification", () => {
		expect(dirAccessState({ infoStatus: "success", hasPassword: true, accepted: false, verifying: false, failed: true })).toBe("wrong")
	})

	it("is ready once the password is accepted, never re-prompting", () => {
		expect(dirAccessState({ infoStatus: "success", hasPassword: true, accepted: true, verifying: false, failed: false })).toBe("ready")
	})
})

describe("linkForBrowsing", () => {
	const info: DirPublicInfo = {
		root: {
			inner: {
				uuid: "11111111-1111-1111-1111-111111111111",
				color: "default",
				timestamp: 0n,
				meta: { type: "decoded", data: { name: "root" } }
			},
			linkedTag: true
		},
		link: {
			linkUuid: "22222222-2222-2222-2222-222222222222",
			linkKey: "linkkey",
			linkKeyVersion: 2,
			password: undefined,
			enableDownload: true,
			salt: "salt"
		},
		hasPassword: true
	}

	it("folds the accepted password into the link handle, carrying it across navigation", () => {
		expect(linkForBrowsing(info, "hunter2").password).toBe("hunter2")
	})

	it("leaves the link password untouched when none is accepted", () => {
		expect(linkForBrowsing(info, undefined).password).toBeUndefined()
	})

	it("preserves the rest of the link handle unchanged", () => {
		const derived = linkForBrowsing(info, "hunter2")

		expect(derived.linkUuid).toBe(info.link.linkUuid)
		expect(derived.linkKey).toBe(info.link.linkKey)
		expect(derived.enableDownload).toBe(true)
	})
})
