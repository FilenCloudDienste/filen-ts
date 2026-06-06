import { vi, describe, it, expect } from "vitest"

import { en } from "@/locales/en"

// Faithful-enough ErrorKind enum (member names mirror @filen/sdk-rs). Numeric values are
// irrelevant here — the same mock object is used on both the call site (kind()) and the switch.
// Hoisted so the vi.mock factory (also hoisted) can reference it.
const { ErrorKindMock } = vi.hoisted(() => {
	const ErrorKindMock = {
		Server: "Server",
		Unauthenticated: "Unauthenticated",
		Reqwest: "Reqwest",
		Response: "Response",
		RetryFailed: "RetryFailed",
		Conversion: "Conversion",
		Io: "Io",
		ChunkTooLarge: "ChunkTooLarge",
		InvalidState: "InvalidState",
		InvalidType: "InvalidType",
		InvalidName: "InvalidName",
		ImageError: "ImageError",
		MetadataWasNotDecrypted: "MetadataWasNotDecrypted",
		Cancelled: "Cancelled",
		HeifError: "HeifError",
		BadRecoveryKey: "BadRecoveryKey",
		Internal: "Internal",
		InsufficientMemory: "InsufficientMemory",
		Walk: "Walk",
		FileChangedDuringSync: "FileChangedDuringSync",
		FolderNotFound: "FolderNotFound",
		WrongPassword: "WrongPassword",
		MaxStorageReached: "MaxStorageReached"
	} as const

	return { ErrorKindMock }
})

// hasInner / getInner are controlled per-test via these mutable cells hoisted alongside the enum.
const { hasInnerRef, getInnerRef } = vi.hoisted(() => {
	const hasInnerRef = { current: (_error: unknown): boolean => false }
	const getInnerRef = { current: (error: unknown): unknown => error }

	return { hasInnerRef, getInnerRef }
})

vi.mock("@filen/sdk-rs", () => {
	class FilenSdkErrorMock {
		public static hasInner(error: unknown): boolean {
			return hasInnerRef.current(error)
		}

		public static getInner(error: unknown): unknown {
			return getInnerRef.current(error)
		}
	}

	return {
		ErrorKind: ErrorKindMock,
		FilenSdkError: FilenSdkErrorMock
	}
})

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("@/constants", async () => await import("@/tests/mocks/constants"))

vi.mock("@/lib/cache", () => ({
	default: {}
}))

// Resolve translation keys against the real English catalog so the translated-kind portion is
// asserted on actual copy (not the raw key i18next would echo when uninitialized).
vi.mock("@/lib/i18n", () => ({
	default: {
		t: (key: keyof typeof en) => en[key]
	}
}))

import { unwrappedSdkErrorToHumanReadable, unwrapSdkError, isNetworkClassError } from "@/lib/sdkErrors"

function makeError(kind: string, message: string) {
	return {
		kind: () => kind,
		message: () => message
	} as unknown as Parameters<typeof unwrappedSdkErrorToHumanReadable>[0]
}

describe("unwrappedSdkErrorToHumanReadable", () => {
	it("returns the translated kind plus the raw untranslated message() suffix", () => {
		const result = unwrappedSdkErrorToHumanReadable(makeError(ErrorKindMock.WrongPassword, "rejected by server"))

		expect(result).toBe(`${en.wrong_password}: (rejected by server)`)
	})

	it("keeps the raw message() verbatim — it is never localized (AIP-193)", () => {
		const raw = "decrypt failed: aes-gcm tag mismatch @ offset 0x1f"
		const result = unwrappedSdkErrorToHumanReadable(makeError(ErrorKindMock.MetadataWasNotDecrypted, raw))

		expect(result).toBe(`${en.metadata_was_not_decrypted}: (${raw})`)
	})

	it("maps both Reqwest and Response to the shared network_error key", () => {
		const reqwest = unwrappedSdkErrorToHumanReadable(makeError(ErrorKindMock.Reqwest, "timeout"))
		const response = unwrappedSdkErrorToHumanReadable(makeError(ErrorKindMock.Response, "502"))

		expect(reqwest).toBe(`${en.network_error}: (timeout)`)
		expect(response).toBe(`${en.network_error}: (502)`)
	})

	it("maps RetryFailed to the distinct network_retry_failed key — not the shared network_error key", () => {
		const result = unwrappedSdkErrorToHumanReadable(makeError(ErrorKindMock.RetryFailed, "gave up"))

		expect(result).toBe(`${en.network_retry_failed}: (gave up)`)
		// Explicit guard: RetryFailed must NOT collapse to the same copy as Reqwest/Response.
		expect(result).not.toBe(`${en.network_error}: (gave up)`)
	})

	it("falls back to the generic key for an unknown kind", () => {
		const result = unwrappedSdkErrorToHumanReadable(makeError("SomethingBrandNew", "weird"))

		expect(result).toBe(`${en.error_generic}: (weird)`)
	})

	// Each arm of the switch gets its own row so a single broken mapping produces an individually
	// identified failure rather than stopping the whole block at the first failed expect().
	it.each([
		[ErrorKindMock.BadRecoveryKey, en.bad_recovery_key],
		[ErrorKindMock.Cancelled, en.operation_cancelled],
		[ErrorKindMock.ChunkTooLarge, en.chunk_too_large],
		[ErrorKindMock.Conversion, en.conversion_error],
		[ErrorKindMock.FileChangedDuringSync, en.file_changed_during_sync],
		[ErrorKindMock.FolderNotFound, en.directory_not_found],
		[ErrorKindMock.HeifError, en.heif_error],
		[ErrorKindMock.ImageError, en.image_error],
		[ErrorKindMock.InsufficientMemory, en.insufficient_memory],
		[ErrorKindMock.Internal, en.internal_error],
		[ErrorKindMock.InvalidName, en.invalid_name],
		[ErrorKindMock.InvalidState, en.invalid_state],
		[ErrorKindMock.InvalidType, en.invalid_type],
		[ErrorKindMock.Io, en.fs_io_error],
		[ErrorKindMock.MaxStorageReached, en.max_remote_storage_reached],
		[ErrorKindMock.Server, en.server_error],
		[ErrorKindMock.Unauthenticated, en.unauthenticated],
		[ErrorKindMock.Walk, en.fs_directory_walk_error]
	])("maps ErrorKind.%s to its translated copy", (kind, expectedCopy) => {
		expect(unwrappedSdkErrorToHumanReadable(makeError(kind, "x"))).toBe(`${expectedCopy}: (x)`)
	})
})

describe("unwrapSdkError", () => {
	it("returns null when the error is not a FilenSdkError wrapper", () => {
		hasInnerRef.current = () => false

		expect(unwrapSdkError(new Error("plain error"))).toBeNull()
		expect(unwrapSdkError("string error")).toBeNull()
		expect(unwrapSdkError(null)).toBeNull()
		expect(unwrapSdkError(undefined)).toBeNull()
	})

	it("returns the inner FilenSdkError when FilenSdkError.hasInner is true", () => {
		const inner = makeError(ErrorKindMock.Reqwest, "network failure")

		hasInnerRef.current = () => true
		getInnerRef.current = () => inner

		const result = unwrapSdkError(new Error("wrapper"))

		expect(result).toBe(inner)
	})

	it("delegates to FilenSdkError.hasInner — does not re-implement the check", () => {
		// Verify the function respects hasInner=false even when given a FilenSdkError-shaped value.
		const inner = makeError(ErrorKindMock.Io, "disk full")

		hasInnerRef.current = () => false
		getInnerRef.current = () => inner

		expect(unwrapSdkError(inner)).toBeNull()
	})
})

describe("isNetworkClassError", () => {
	it("returns false for a plain (non-SDK) error", () => {
		hasInnerRef.current = () => false

		expect(isNetworkClassError(new Error("plain"))).toBe(false)
	})

	it("returns false for null / undefined", () => {
		hasInnerRef.current = () => false

		expect(isNetworkClassError(null)).toBe(false)
		expect(isNetworkClassError(undefined)).toBe(false)
	})

	it("returns true for a Reqwest-kind SDK error", () => {
		const inner = makeError(ErrorKindMock.Reqwest, "connection refused")

		hasInnerRef.current = () => true
		getInnerRef.current = () => inner

		expect(isNetworkClassError(new Error("wrapper"))).toBe(true)
	})

	it("returns true for a Response-kind SDK error", () => {
		const inner = makeError(ErrorKindMock.Response, "503")

		hasInnerRef.current = () => true
		getInnerRef.current = () => inner

		expect(isNetworkClassError(new Error("wrapper"))).toBe(true)
	})

	it("returns true for a RetryFailed-kind SDK error", () => {
		const inner = makeError(ErrorKindMock.RetryFailed, "gave up after 5 attempts")

		hasInnerRef.current = () => true
		getInnerRef.current = () => inner

		expect(isNetworkClassError(new Error("wrapper"))).toBe(true)
	})

	it("returns false for a non-network SDK error kind (e.g. WrongPassword)", () => {
		const inner = makeError(ErrorKindMock.WrongPassword, "bad creds")

		hasInnerRef.current = () => true
		getInnerRef.current = () => inner

		expect(isNetworkClassError(new Error("wrapper"))).toBe(false)
	})

	it("returns false for an Internal SDK error kind", () => {
		const inner = makeError(ErrorKindMock.Internal, "panic")

		hasInnerRef.current = () => true
		getInnerRef.current = () => inner

		expect(isNetworkClassError(new Error("wrapper"))).toBe(false)
	})
})
