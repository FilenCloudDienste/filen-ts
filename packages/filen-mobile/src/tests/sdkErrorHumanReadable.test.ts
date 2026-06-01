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

vi.mock("@filen/sdk-rs", () => {
	class FilenSdkErrorMock {
		public static hasInner(): boolean {
			return false
		}

		public static getInner(error: unknown): unknown {
			return error
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

import { unwrappedSdkErrorToHumanReadable } from "@/lib/utils"

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
		expect(result.endsWith(`(${raw})`)).toBe(true)
	})

	it("maps both Reqwest and Response to the shared network_error key", () => {
		const reqwest = unwrappedSdkErrorToHumanReadable(makeError(ErrorKindMock.Reqwest, "timeout"))
		const response = unwrappedSdkErrorToHumanReadable(makeError(ErrorKindMock.Response, "502"))

		expect(reqwest).toBe(`${en.network_error}: (timeout)`)
		expect(response).toBe(`${en.network_error}: (502)`)
	})

	it("falls back to the generic key for an unknown kind", () => {
		const result = unwrappedSdkErrorToHumanReadable(makeError("SomethingBrandNew", "weird"))

		expect(result).toBe(`${en.error_generic}: (weird)`)
	})

	it("translates a representative spread of mapped kinds", () => {
		expect(unwrappedSdkErrorToHumanReadable(makeError(ErrorKindMock.FolderNotFound, "x"))).toBe(`${en.directory_not_found}: (x)`)
		expect(unwrappedSdkErrorToHumanReadable(makeError(ErrorKindMock.MaxStorageReached, "x"))).toBe(
			`${en.max_remote_storage_reached}: (x)`
		)
		expect(unwrappedSdkErrorToHumanReadable(makeError(ErrorKindMock.Unauthenticated, "x"))).toBe(`${en.unauthenticated}: (x)`)
		expect(unwrappedSdkErrorToHumanReadable(makeError(ErrorKindMock.Walk, "x"))).toBe(`${en.fs_directory_walk_error}: (x)`)
	})
})
