import { describe, it, expect } from "vitest"
import {
	isNetworkClassErrorKind,
	isRetryableAuthErrorKind,
	isRetryableLockErrorKind,
	isTlsVerificationErrorKind,
	isPermanentRejection,
	TLS_VERIFICATION_ERROR_KIND
} from "@filen/shared"

describe("isNetworkClassErrorKind", () => {
	it("matches the three network-class kinds", () => {
		expect(isNetworkClassErrorKind("Reqwest")).toBe(true)
		expect(isNetworkClassErrorKind("RetryFailed")).toBe(true)
		expect(isNetworkClassErrorKind("Response")).toBe(true)
	})

	it("rejects any other kind, including undefined", () => {
		expect(isNetworkClassErrorKind("Server")).toBe(false)
		expect(isNetworkClassErrorKind("Unauthenticated")).toBe(false)
		expect(isNetworkClassErrorKind(undefined)).toBe(false)
	})
})

describe("isRetryableAuthErrorKind", () => {
	it("matches only Unauthenticated", () => {
		expect(isRetryableAuthErrorKind("Unauthenticated")).toBe(true)
		expect(isRetryableAuthErrorKind("Reqwest")).toBe(false)
		expect(isRetryableAuthErrorKind(undefined)).toBe(false)
	})
})

describe("isRetryableLockErrorKind", () => {
	it("matches only LockLost", () => {
		expect(isRetryableLockErrorKind("LockLost")).toBe(true)
		expect(isRetryableLockErrorKind("Server")).toBe(false)
		expect(isRetryableLockErrorKind(undefined)).toBe(false)
	})
})

describe("isTlsVerificationErrorKind", () => {
	it("matches only the TLS verification kind", () => {
		expect(isTlsVerificationErrorKind(TLS_VERIFICATION_ERROR_KIND)).toBe(true)
		expect(isTlsVerificationErrorKind("Reqwest")).toBe(false)
		expect(isTlsVerificationErrorKind(undefined)).toBe(false)
	})
})

describe("isPermanentRejection", () => {
	it("short-circuits false when there is no SDK error at all", () => {
		expect(isPermanentRejection({ hasSdkError: false, kind: "Server" })).toBe(false)
		expect(isPermanentRejection({ hasSdkError: false, kind: undefined })).toBe(false)
	})

	it("keeps network-class SDK errors for retry", () => {
		expect(isPermanentRejection({ hasSdkError: true, kind: "Reqwest" })).toBe(false)
		expect(isPermanentRejection({ hasSdkError: true, kind: "RetryFailed" })).toBe(false)
		expect(isPermanentRejection({ hasSdkError: true, kind: "Response" })).toBe(false)
	})

	it("keeps a recoverable-auth SDK error for retry", () => {
		expect(isPermanentRejection({ hasSdkError: true, kind: "Unauthenticated" })).toBe(false)
	})

	it("keeps a lost-lock SDK error for retry", () => {
		expect(isPermanentRejection({ hasSdkError: true, kind: "LockLost" })).toBe(false)
	})

	it("keeps a TLS verification failure for retry", () => {
		expect(isPermanentRejection({ hasSdkError: true, kind: TLS_VERIFICATION_ERROR_KIND })).toBe(false)
	})

	it("is permanent for any other SDK error kind", () => {
		expect(isPermanentRejection({ hasSdkError: true, kind: "Server" })).toBe(true)
		expect(isPermanentRejection({ hasSdkError: true, kind: undefined })).toBe(true)
	})
})
