import { describe, expect, it } from "vitest"
import type { DirPublicInfo, PasswordState } from "@filen/sdk-rs"
import { fileAccessState, dirAccessState, linkForBrowsing } from "@/features/publicLinks/lib/password.logic"

const passwordError = { kind: "wrongPassword", label: "Wrong password", message: "" }
const deadLinkError = { kind: "notFound", label: "not found", message: "" }
// An SDK error whose kind is one of the shared network-class kinds (wire/transport failure the SDK
// already exhausted its own retries on) — the only class that earns the retryable surface.
const transientError = { species: "sdk", kind: "Reqwest", label: "network error", message: "" }

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

	it("collapses a dead/not-found link into the terminal invalid surface, never a retry loop", () => {
		expect(fileAccessState({ status: "error", error: deadLinkError, submitted: false })).toBe("invalid")
		expect(fileAccessState({ status: "error", error: deadLinkError, submitted: true })).toBe("invalid")
	})

	it("reserves the retryable surface for a genuinely transient wire failure", () => {
		expect(fileAccessState({ status: "error", error: transientError, submitted: false })).toBe("error")
	})

	it("is ready on success", () => {
		expect(fileAccessState({ status: "success", error: undefined, submitted: true })).toBe("ready")
	})
})

describe("dirAccessState", () => {
	it("is loading while info resolves", () => {
		expect(
			dirAccessState({
				infoStatus: "pending",
				infoError: undefined,
				hasPassword: false,
				accepted: false,
				verifying: false,
				failed: false
			})
		).toBe("loading")
	})

	it("collapses a dead/not-found info error into the terminal invalid surface", () => {
		expect(
			dirAccessState({
				infoStatus: "error",
				infoError: deadLinkError,
				hasPassword: false,
				accepted: false,
				verifying: false,
				failed: false
			})
		).toBe("invalid")
	})

	it("reserves the retryable surface for a transient info error", () => {
		expect(
			dirAccessState({
				infoStatus: "error",
				infoError: transientError,
				hasPassword: false,
				accepted: false,
				verifying: false,
				failed: false
			})
		).toBe("error")
	})

	it("is ready immediately for an unprotected link", () => {
		expect(
			dirAccessState({
				infoStatus: "success",
				infoError: undefined,
				hasPassword: false,
				accepted: false,
				verifying: false,
				failed: false
			})
		).toBe("ready")
	})

	it("prompts for a protected link before acceptance", () => {
		expect(
			dirAccessState({
				infoStatus: "success",
				infoError: undefined,
				hasPassword: true,
				accepted: false,
				verifying: false,
				failed: false
			})
		).toBe("prompt")
	})

	it("is checking while a candidate password verifies", () => {
		expect(
			dirAccessState({
				infoStatus: "success",
				infoError: undefined,
				hasPassword: true,
				accepted: false,
				verifying: true,
				failed: false
			})
		).toBe("checking")
	})

	it("reports wrong after a failed verification", () => {
		expect(
			dirAccessState({
				infoStatus: "success",
				infoError: undefined,
				hasPassword: true,
				accepted: false,
				verifying: false,
				failed: true
			})
		).toBe("wrong")
	})

	it("is ready once the password is accepted, never re-prompting", () => {
		expect(
			dirAccessState({
				infoStatus: "success",
				infoError: undefined,
				hasPassword: true,
				accepted: true,
				verifying: false,
				failed: false
			})
		).toBe("ready")
	})
})

describe("linkForBrowsing", () => {
	// The only producer that reaches this function is the ANONYMOUS info call, and it hardcodes
	// `PasswordState::None` on the link it builds (the `v3/dir/link/info` response carries `hasPassword`
	// and a salt, never a hash). So `hasPassword` alone distinguishes a protected link here — its
	// `link.password` is "none" either way, and the prompt is driven by `hasPassword` via dirAccessState.
	function dirInfo(hasPassword: boolean, password: PasswordState = { type: "none" }): DirPublicInfo {
		return {
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
				password,
				enableDownload: true,
				salt: "salt"
			},
			hasPassword
		}
	}

	const protectedInfo = dirInfo(true)
	const unprotectedInfo = dirInfo(false)

	it("folds the accepted password into the link handle as a known state, carrying it across navigation", () => {
		expect(linkForBrowsing(protectedInfo, "hunter2").password).toEqual({ type: "known", data: "hunter2" })
	})

	// Before acceptance a protected link browses anonymously — that empty state is exactly what
	// dirAccessState turns into the prompt, so inventing an auth state here would skip the gate.
	it("leaves the info call's empty state alone until a password is accepted", () => {
		expect(linkForBrowsing(protectedInfo, undefined).password).toEqual({ type: "none" })
		expect(linkForBrowsing(unprotectedInfo, undefined).password).toEqual({ type: "none" })
	})

	// Exercises the declared `PasswordState` union beyond what this call site can produce: "hashed"
	// reaches a DirPublicLink only through the authenticated owner-links conversion. It pins the
	// no-password branch as a genuine passthrough rather than a hardcoded literal.
	it("passes any other declared password state through untouched", () => {
		const hashedInfo = dirInfo(true, { type: "hashed", data: "the-hashed-password" })

		expect(linkForBrowsing(hashedInfo, undefined).password).toEqual({ type: "hashed", data: "the-hashed-password" })
	})

	it("preserves the rest of the link handle unchanged", () => {
		const derived = linkForBrowsing(protectedInfo, "hunter2")

		expect(derived.linkUuid).toBe(protectedInfo.link.linkUuid)
		expect(derived.linkKey).toBe(protectedInfo.link.linkKey)
		expect(derived.enableDownload).toBe(true)
	})
})
