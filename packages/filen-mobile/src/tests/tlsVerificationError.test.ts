import { vi, describe, it, expect, beforeEach } from "vitest"

vi.mock("@/lib/i18n", async () => await import("@/tests/mocks/i18n"))

// The real sdkErrors classifiers over the shared SDK error mock.
vi.mock("@filen/sdk-rs", async () => {
	const m = await import("@/tests/mocks/sdkErrors")

	return { ErrorKind: m.ErrorKind, FilenSdkError: m.FilenSdkError }
})

import { asSdkError, sdkErrorState } from "@/tests/mocks/sdkErrors"
import { ErrorKind } from "@filen/sdk-rs"
import {
	isTlsVerificationError,
	isTlsVerificationErrorKind,
	isPermanentSdkRejection,
	sdkErrorPartsToHumanReadable,
	classifyReachabilityProbeError
} from "@/lib/sdkErrors"
import { ConnectionTrust } from "@/lib/connectionTrust"
import { errors } from "@/locales/en/errors"

beforeEach(() => {
	sdkErrorState.innerOf.clear()
})

describe("TLS verification error mapping", () => {
	it("recognizes the TLS verification kind and nothing else", () => {
		expect(isTlsVerificationErrorKind(ErrorKind.TlsVerification)).toBe(true)
		expect(isTlsVerificationErrorKind(ErrorKind.Reqwest)).toBe(false)
		expect(isTlsVerificationError(asSdkError(new Error("tls"), "TlsVerification"))).toBe(true)
		expect(isTlsVerificationError(asSdkError(new Error("net"), "Reqwest"))).toBe(false)
		expect(isTlsVerificationError(new Error("plain"))).toBe(false)
	})

	it("labels it with the secure-connection message, not the network error", () => {
		// The i18n mock translates a key to itself.
		expect(sdkErrorPartsToHumanReadable({ kind: ErrorKind.TlsVerification, serverMessage: undefined, innerMessage: "invalid peer certificate" })).toBe(
			"secure_connection_unverified"
		)
		expect(errors.secure_connection_unverified).toBe("A secure connection to Filen couldn't be verified.")
	})

	it("keeps an outbox entry that failed certificate verification for retry", () => {
		expect(isPermanentSdkRejection(asSdkError(new Error("tls"), "TlsVerification"))).toBe(false)
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

describe("classifyReachabilityProbeError", () => {
	it("reads a rejected certificate as unverified, never as offline", () => {
		expect(classifyReachabilityProbeError(asSdkError(new Error("tls"), "TlsVerification"))).toBe("unverified")
	})

	it("reads a transport failure the SDK already retried as unreachable", () => {
		for (const kind of ["Reqwest", "RetryFailed", "Response"]) {
			expect(classifyReachabilityProbeError(asSdkError(new Error(kind), kind))).toBe("unreachable")
		}
	})

	it("reads any other SDK error as an answer from Filen, so reachable", () => {
		// The probe's nil public link is answered with an API error; a session the server refuses is
		// still the server answering.
		for (const kind of ["Server", "FolderNotFound", "Unauthenticated"]) {
			expect(classifyReachabilityProbeError(asSdkError(new Error(kind), kind))).toBe("reachable")
		}
	})

	it("learns nothing from a cancelled call or a non-SDK throw", () => {
		expect(classifyReachabilityProbeError(asSdkError(new Error("cancelled"), "Cancelled"))).toBe("inconclusive")
		expect(classifyReachabilityProbeError(new Error("AbortError"))).toBe("inconclusive")
		expect(classifyReachabilityProbeError("aborted")).toBe("inconclusive")
	})
})
