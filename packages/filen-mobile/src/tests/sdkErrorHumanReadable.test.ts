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

function makeError(
	kind: string,
	message = "",
	opts: { serverMessage?: string; serverCode?: string; innerMessage?: string } = {}
) {
	return {
		kind: () => kind,
		message: () => message,
		serverMessage: () => opts.serverMessage,
		serverCode: () => opts.serverCode,
		innerMessage: () => opts.innerMessage
	} as unknown as Parameters<typeof unwrappedSdkErrorToHumanReadable>[0]
}

describe("unwrappedSdkErrorToHumanReadable", () => {
	it("returns the server's own message for a server/API error", () => {
		const result = unwrappedSdkErrorToHumanReadable(
			makeError(ErrorKindMock.WrongPassword, "", {
				serverMessage: "The password you entered is incorrect.",
				serverCode: "wrong_password"
			})
		)

		expect(result).toBe("The password you entered is incorrect.")
	})

	it("uses the friendly localized label for a known non-server kind, ignoring the technical inner", () => {
		const result = unwrappedSdkErrorToHumanReadable(
			makeError(ErrorKindMock.Reqwest, "", { innerMessage: "error sending request for url (https://gateway.filen.io)" })
		)

		// Network/parse/codec inners are technical Rust/reqwest strings; the label wins.
		expect(result).toBe(en.network_error)
	})

	it("falls back to the raw inner Rust message only for an UNMAPPED kind", () => {
		const result = unwrappedSdkErrorToHumanReadable(
			makeError("SomethingBrandNew", "", { innerMessage: "low-level thing went wrong" })
		)

		expect(result).toBe("low-level thing went wrong")
	})

	it("uses the translated label (never the raw inner) for a server error with a code but no message", () => {
		const result = unwrappedSdkErrorToHumanReadable(
			makeError(ErrorKindMock.MaxStorageReached, "", {
				serverCode: "max_storage_reached",
				innerMessage: 'API Error, message: `None`, code: `Some("max_storage_reached")`'
			})
		)

		expect(result).toBe(en.max_remote_storage_reached)
	})

	it("uses the translated label for the generic Server kind with no server message", () => {
		const result = unwrappedSdkErrorToHumanReadable(
			makeError(ErrorKindMock.Server, "", { innerMessage: "API Error, message: `None`, code: `None`" })
		)

		expect(result).toBe(en.server_error)
	})

	it("falls back to the generic key for an unknown kind with no messages", () => {
		expect(unwrappedSdkErrorToHumanReadable(makeError("SomethingBrandNew"))).toBe(en.error_generic)
	})

	// The kind -> translated label fallback, used when neither a server message nor an inner
	// message is available. Each arm gets its own row so one broken mapping fails individually.
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
		[ErrorKindMock.Reqwest, en.network_error],
		[ErrorKindMock.Response, en.network_error],
		[ErrorKindMock.RetryFailed, en.network_retry_failed],
		[ErrorKindMock.Server, en.server_error],
		[ErrorKindMock.Unauthenticated, en.unauthenticated],
		[ErrorKindMock.Walk, en.fs_directory_walk_error]
	])("maps ErrorKind.%s to its translated label when no message is present", (kind, expectedCopy) => {
		expect(unwrappedSdkErrorToHumanReadable(makeError(kind))).toBe(expectedCopy)
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
