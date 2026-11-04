import { vi, describe, it, expect, beforeEach } from "vitest"
import { TLS_VERIFICATION_ERROR_KIND } from "@filen/shared"

vi.mock("@/lib/i18n", async () => await import("@/tests/mocks/i18n"))

// The real sdkErrors classifiers over the shared SDK error mock, with the TLS verification kind added
// under the name the SDK exports it by.
vi.mock("@filen/sdk-rs", async () => {
	const m = await import("@/tests/mocks/sdkErrors")
	const { TLS_VERIFICATION_ERROR_KIND: tlsKind } = await import("@filen/shared")

	return { ErrorKind: { ...m.ErrorKind, [tlsKind]: tlsKind }, FilenSdkError: m.FilenSdkError }
})

import { asSdkError, sdkErrorState } from "@/tests/mocks/sdkErrors"
import { ErrorKind } from "@filen/sdk-rs"
import { isTlsVerificationError, isTlsVerificationErrorKind, isPermanentSdkRejection, sdkErrorPartsToHumanReadable } from "@/lib/sdkErrors"
import { ConnectionTrust } from "@/lib/connectionTrust"
import { errors } from "@/locales/en/errors"

const tlsKind = (ErrorKind as unknown as Record<string, ErrorKind>)[TLS_VERIFICATION_ERROR_KIND] as ErrorKind

beforeEach(() => {
	sdkErrorState.innerOf.clear()
})

describe("TLS verification error mapping", () => {
	it("recognizes the TLS verification kind and nothing else", () => {
		expect(isTlsVerificationErrorKind(tlsKind)).toBe(true)
		expect(isTlsVerificationErrorKind(ErrorKind.Reqwest)).toBe(false)
		expect(isTlsVerificationError(asSdkError(new Error("tls"), TLS_VERIFICATION_ERROR_KIND))).toBe(true)
		expect(isTlsVerificationError(asSdkError(new Error("net"), "Reqwest"))).toBe(false)
		expect(isTlsVerificationError(new Error("plain"))).toBe(false)
	})

	it("labels it with the secure-connection message, not the network error", () => {
		// The i18n mock translates a key to itself.
		expect(sdkErrorPartsToHumanReadable({ kind: tlsKind, serverMessage: undefined, innerMessage: "invalid peer certificate" })).toBe(
			"secure_connection_unverified"
		)
		expect(errors.secure_connection_unverified).toBe("A secure connection to Filen couldn't be verified.")
	})

	it("keeps an outbox entry that failed certificate verification for retry", () => {
		expect(isPermanentSdkRejection(asSdkError(new Error("tls"), TLS_VERIFICATION_ERROR_KIND))).toBe(false)
	})
})

describe("ConnectionTrust", () => {
	it("notifies once per change", () => {
		const trust = new ConnectionTrust()
		const listener = vi.fn()

		trust.subscribe(listener)
		trust.markUnverified()
		trust.markUnverified()

		expect(trust.isUnverified()).toBe(true)
		expect(listener).toHaveBeenCalledTimes(1)

		trust.clear()
		trust.clear()

		expect(trust.isUnverified()).toBe(false)
		expect(listener).toHaveBeenCalledTimes(2)
	})

	it("stops notifying an unsubscribed listener", () => {
		const trust = new ConnectionTrust()
		const listener = vi.fn()
		const unsubscribe = trust.subscribe(listener)

		unsubscribe()
		trust.markUnverified()

		expect(listener).not.toHaveBeenCalled()
	})
})

describe("TLS verification kind on an SDK that predates it", () => {
	it("never matches when ErrorKind has no such member", async () => {
		vi.resetModules()
		vi.doMock("@filen/sdk-rs", async () => {
			const m = await import("@/tests/mocks/sdkErrors")

			return { ErrorKind: m.ErrorKind, FilenSdkError: m.FilenSdkError }
		})

		const fresh = await import("@/lib/sdkErrors")

		expect(fresh.isTlsVerificationErrorKind(TLS_VERIFICATION_ERROR_KIND as unknown as ErrorKind)).toBe(false)

		vi.doUnmock("@filen/sdk-rs")
	})
})
