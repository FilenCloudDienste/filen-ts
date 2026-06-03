import { vi, describe, it, expect } from "vitest"

// Mock i18n so unwrappedSdkErrorToHumanReadable tests don't drag in expo/react-native
vi.mock("@/lib/i18n", () => ({
	default: {
		t: (key: string) => key
	}
}))

// @filen/sdk-rs mock: ErrorKind values match the actual WASM string literals from sdk-rs.d.ts.
// The switch in utils.ts references ErrorKind.X — our mock must supply matching string values.
// NOTE: the SDK type exposes ErrorKind as string literals: "IO" (not "Io"), and "HeifError" is
// absent from the published union type — the utils.ts switch references ErrorKind.HeifError and
// ErrorKind.Io, but those names are resolved through this mock, so we match what the switch uses.
vi.mock("@filen/sdk-rs", () => {
	// Values must equal what the switch compares against at runtime.
	// The real SDK type union includes "IO" (uppercase) but utils.ts uses ErrorKind.Io (camelCase
	// property access). We set Io: "IO" so the mock property matches the SDK constant value.
	// HeifError is not in the published SDK type union but IS referenced in the switch; we set
	// HeifError: "HeifError" which means the switch case CAN match if the SDK ever emits that kind,
	// but in practice it will fall through to the default branch (see deferred note in spec output).
	const ErrorKind = {
		Server: "Server",
		Unauthenticated: "Unauthenticated",
		Reqwest: "Reqwest",
		Response: "Response",
		RetryFailed: "RetryFailed",
		Conversion: "Conversion",
		Io: "IO",
		ChunkTooLarge: "ChunkTooLarge",
		InvalidState: "InvalidState",
		InvalidType: "InvalidType",
		InvalidName: "InvalidName",
		ImageError: "ImageError",
		MetadataWasNotDecrypted: "MetadataWasNotDecrypted",
		Cancelled: "Cancelled",
		BadRecoveryKey: "BadRecoveryKey",
		Internal: "Internal",
		InsufficientMemory: "InsufficientMemory",
		Walk: "Walk",
		FileChangedDuringSync: "FileChangedDuringSync",
		FolderNotFound: "FolderNotFound",
		WrongPassword: "WrongPassword",
		MaxStorageReached: "MaxStorageReached",
		FileChunkNotFound: "FileChunkNotFound",
		FileNotFound: "FileNotFound",
		EmailOrPasswordWrong: "EmailOrPasswordWrong",
		Enter2fa: "Enter2fa",
		Wrong2fa: "Wrong2fa",
		// HeifError is referenced in the utils.ts switch but absent from the SDK published type union.
		// We set it to "HeifError" so the mock property resolves; whether the SDK emits this value
		// at runtime is the open question flagged in the deferred section.
		HeifError: "HeifError"
	}

	return { ErrorKind }
})

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))
vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

// expo-file-system is pulled in transitively by utils.ts via storageRoots / fsUtils
vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("@/lib/cache", () => ({ default: { rootUuid: null } }))

import { common } from "@/locales/en/common"
import { errors } from "@/locales/en/errors"
import { sort } from "@/locales/en/sort"
import { drive } from "@/locales/en/drive"
import { en } from "@/locales/en"

import { appearance } from "@/locales/en/appearance"
import { auth } from "@/locales/en/auth"
import { chats } from "@/locales/en/chats"
import { contacts } from "@/locales/en/contacts"
import { drivePreview } from "@/locales/en/drivePreview"
import { media } from "@/locales/en/media"
import { misc } from "@/locales/en/misc"
import { notes } from "@/locales/en/notes"
import { security } from "@/locales/en/security"
import { settings } from "@/locales/en/settings"
import { transfers } from "@/locales/en/transfers"

// Imported real; mocks only cover its boundaries (i18n, expo-file-system, @filen/sdk-rs)
import { unwrappedSdkErrorToHumanReadable } from "@/lib/utils"

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal FilenSdkError-shaped object without the native SDK class */
function fakeError(kind: string, message = "raw diagnostic"): Parameters<typeof unwrappedSdkErrorToHumanReadable>[0] {
	return {
		kind: () => kind,
		message: () => message
	} as unknown as Parameters<typeof unwrappedSdkErrorToHumanReadable>[0]
}

// ── errors catalog ────────────────────────────────────────────────────────────

describe("errors catalog", () => {
	it("exposes one key per SDK error kind plus a generic fallback — specific values", () => {
		expect(errors.bad_recovery_key).toBe("The recovery key is invalid. Please double-check it and try again.")
		expect(errors.directory_not_found).toBe("Directory not found.")
		expect(errors.wrong_password).toBe("Wrong password. Please try again.")
		expect(errors.operation_cancelled).toBe("The operation was cancelled.")
		expect(errors.network_error).toBe("Network error. Please check your connection and try again.")
		expect(errors.network_retry_failed).toBe("The request failed repeatedly. Please check your connection and try again.")
		expect(errors.error_generic).toBe("Something went wrong. Please try again.")
	})

	it("covers every kind referenced by the SDK error mapper", () => {
		const expected = [
			"bad_recovery_key",
			"directory_not_found",
			"wrong_password",
			"operation_cancelled",
			"chunk_too_large",
			"conversion_error",
			"file_changed_during_sync",
			"heif_error",
			"image_error",
			"insufficient_memory",
			"internal_error",
			"invalid_name",
			"invalid_state",
			"invalid_type",
			"fs_io_error",
			"max_remote_storage_reached",
			"metadata_was_not_decrypted",
			"network_error",
			"network_retry_failed",
			"server_error",
			"unauthenticated",
			"fs_directory_walk_error",
			"error_generic"
		]

		for (const key of expected) {
			expect(errors).toHaveProperty(key)
		}
	})

	it("every errors.* value is a non-empty string", () => {
		for (const [key, value] of Object.entries(errors)) {
			expect(typeof value, `errors.${key} should be a string`).toBe("string")
			expect((value as string).length, `errors.${key} must not be empty`).toBeGreaterThan(0)
		}
	})
})

// ── sort catalog ──────────────────────────────────────────────────────────────

describe("sort catalog", () => {
	it("exposes the fixed notes-group bucket / state labels with exact values", () => {
		expect(sort.today).toBe("Today")
		expect(sort.previous_7_days).toBe("Previous 7 days")
		expect(sort.previous_30_days).toBe("Previous 30 days")
		expect(sort.pinned).toBe("Pinned")
		expect(sort.favorited).toBe("Favorited")
		expect(sort.archived).toBe("Archived")
		expect(sort.trashed).toBe("Trashed")
	})

	it("contains exactly the 7 fixed bucket labels and no runtime-derived month-name keys", () => {
		const keys = Object.keys(sort)

		// The 7 fixed labels must be present
		expect(keys).toContain("today")
		expect(keys).toContain("previous_7_days")
		expect(keys).toContain("previous_30_days")
		expect(keys).toContain("pinned")
		expect(keys).toContain("favorited")
		expect(keys).toContain("archived")
		expect(keys).toContain("trashed")

		// No month_N or tbd_month_N keys must be present: month names derive from Intl at runtime
		const monthKeys = keys.filter(k => /^(tbd_)?month_\d+$/.test(k))

		expect(monthKeys).toHaveLength(0)
	})
})

// ── drive catalog ─────────────────────────────────────────────────────────────

describe("drive catalog", () => {
	it("exposes the public-link password prompt copy with exact values", () => {
		// password_required is a shared key — it lives in common.ts (used by drive + drivePreview)
		expect(common.password_required).toBe("Password required")
		expect(drive).not.toHaveProperty("password_required")
		expect(drive.enter_public_link_directory_password).toBe("Enter the password for this directory link")
		expect(drive.enter_public_link_file_password).toBe("Enter the password for this file link")
	})

	it("reuses shared submit/cancel from common and wrong_password from errors", () => {
		expect(common.submit).toBe("Submit")
		expect(common.cancel).toBe("Cancel")
		expect(drive).not.toHaveProperty("submit")
		expect(drive).not.toHaveProperty("cancel")
		expect(drive).not.toHaveProperty("wrong_password")
		// wrong_password lives in errors, not here — verified by the errors catalog tests above
	})
})

// ── catalog barrel merge (ALL 14 modules) ─────────────────────────────────────

describe("catalog barrel merge", () => {
	it("merges all 14 catalogs into en with zero duplicate keys", () => {
		const allKeys = [
			...Object.keys(common),
			...Object.keys(appearance),
			...Object.keys(auth),
			...Object.keys(chats),
			...Object.keys(contacts),
			...Object.keys(drive),
			...Object.keys(drivePreview),
			...Object.keys(errors),
			...Object.keys(media),
			...Object.keys(misc),
			...Object.keys(notes),
			...Object.keys(security),
			...Object.keys(settings),
			...Object.keys(sort),
			...Object.keys(transfers)
		]

		const uniqueKeys = new Set(allKeys)

		// If sizes differ, find the collisions for a useful failure message
		if (uniqueKeys.size !== allKeys.length) {
			const seen = new Set<string>()
			const duplicates: string[] = []

			for (const k of allKeys) {
				if (seen.has(k)) {
					duplicates.push(k)
				}

				seen.add(k)
			}

			// This assertion will always fail here — it surfaces the collision names
			expect(duplicates).toHaveLength(0)
		}

		expect(uniqueKeys.size).toBe(allKeys.length)
	})

	it("every key from every catalog is reachable in the merged en object", () => {
		const catalogs = [
			common,
			appearance,
			auth,
			chats,
			contacts,
			drive,
			drivePreview,
			errors,
			media,
			misc,
			notes,
			security,
			settings,
			sort,
			transfers
		] as const

		for (const catalog of catalogs) {
			for (const key of Object.keys(catalog)) {
				expect(en).toHaveProperty(key)
			}
		}
	})
})

// ── plural suffix policy ──────────────────────────────────────────────────────

describe("plural-suffix policy (Risk 1 from common.ts comments)", () => {
	// i18next pluralSeparator defaults to "_", so a NON-plural key ending in
	// _one / _other / _zero / _two / _few / _many / _male / _female would break
	// plural resolution for any base key that legitimately uses those suffixes.
	// Plural keys ARE allowed: they must appear as a base/_one/_other pair.

	const PLURAL_CONTEXT_SUFFIXES = ["_one", "_other", "_zero", "_two", "_few", "_many", "_male", "_female"]

	function isPlural(key: string): boolean {
		return PLURAL_CONTEXT_SUFFIXES.some(suffix => key.endsWith(suffix))
	}

	function hasPluralCounterpart(key: string, allKeys: Set<string>): boolean {
		// A key ending in _one must have a corresponding _other, and vice versa.
		// That makes it a legitimate i18next plural pair.
		if (key.endsWith("_one")) {
			const base = key.slice(0, -"_one".length)

			return allKeys.has(`${base}_other`)
		}

		if (key.endsWith("_other")) {
			const base = key.slice(0, -"_other".length)

			return allKeys.has(`${base}_one`)
		}

		// For the rarer suffixes (_zero, _two, _few, _many) we require _one to co-exist
		for (const suffix of ["_zero", "_two", "_few", "_many"]) {
			if (key.endsWith(suffix)) {
				const base = key.slice(0, -suffix.length)

				return allKeys.has(`${base}_one`)
			}
		}

		// _male/_female: require the other to exist
		if (key.endsWith("_male")) {
			const base = key.slice(0, -"_male".length)

			return allKeys.has(`${base}_female`)
		}

		if (key.endsWith("_female")) {
			const base = key.slice(0, -"_female".length)

			return allKeys.has(`${base}_male`)
		}

		return false
	}

	it("no non-plural key in any catalog ends with an i18next plural/context suffix", () => {
		const catalogs: Record<string, object> = {
			common,
			appearance,
			auth,
			chats,
			contacts,
			drive,
			drivePreview,
			errors,
			media,
			misc,
			notes,
			security,
			settings,
			sort,
			transfers
		}

		const offenders: string[] = []

		for (const [catalogName, catalog] of Object.entries(catalogs)) {
			const allKeys = new Set(Object.keys(catalog))

			for (const key of allKeys) {
				if (isPlural(key) && !hasPluralCounterpart(key, allKeys)) {
					offenders.push(`${catalogName}.${key}`)
				}
			}
		}

		expect(offenders).toHaveLength(0)
	})
})

// ── unwrappedSdkErrorToHumanReadable mapping completeness ─────────────────────

describe("unwrappedSdkErrorToHumanReadable", () => {
	// The i18n mock returns the key verbatim so we can assert which catalog key
	// was selected without needing a real i18next instance.

	it("maps ErrorKind.Reqwest to network_error", () => {
		const result = unwrappedSdkErrorToHumanReadable(fakeError("Reqwest"))

		expect(result).toContain("network_error")
	})

	it("maps ErrorKind.Response to network_error (same key as Reqwest — two-to-one mapping)", () => {
		const result = unwrappedSdkErrorToHumanReadable(fakeError("Response"))

		expect(result).toContain("network_error")
	})

	it("maps ErrorKind.RetryFailed to network_retry_failed (distinct from Response/Reqwest)", () => {
		const result = unwrappedSdkErrorToHumanReadable(fakeError("RetryFailed"))

		expect(result).toContain("network_retry_failed")
		expect(result).not.toContain("network_error:")
	})

	it("falls through to error_generic for an unknown ErrorKind", () => {
		const result = unwrappedSdkErrorToHumanReadable(fakeError("SomeUnknownKind"))

		expect(result).toContain("error_generic")
	})

	it("appends the raw message() as a diagnostic suffix", () => {
		const result = unwrappedSdkErrorToHumanReadable(fakeError("Server", "upstream 503"))

		// Raw message must appear in the output regardless of which key was selected
		expect(result).toContain("upstream 503")
	})

	it("maps every handled ErrorKind to a non-generic catalog key", () => {
		// Use the RUNTIME VALUES of ErrorKind (what the switch compares against), not the property
		// names. e.g. ErrorKind.Io === "IO", ErrorKind.HeifError === "HeifError" per the mock above.
		// Each tuple is [runtimeKindValue, expectedCatalogKey].
		const expectedMappings: Array<[kindValue: string, expectedKey: string]> = [
			["BadRecoveryKey", "bad_recovery_key"],
			["FolderNotFound", "directory_not_found"],
			["WrongPassword", "wrong_password"],
			["Cancelled", "operation_cancelled"],
			["ChunkTooLarge", "chunk_too_large"],
			["Conversion", "conversion_error"],
			["FileChangedDuringSync", "file_changed_during_sync"],
			["HeifError", "heif_error"],
			["ImageError", "image_error"],
			["InsufficientMemory", "insufficient_memory"],
			["Internal", "internal_error"],
			["InvalidName", "invalid_name"],
			["InvalidState", "invalid_state"],
			["InvalidType", "invalid_type"],
			// SDK publishes "IO" (not "Io") as the runtime string; ErrorKind.Io resolves to "IO".
			["IO", "fs_io_error"],
			["MaxStorageReached", "max_remote_storage_reached"],
			["MetadataWasNotDecrypted", "metadata_was_not_decrypted"],
			["Reqwest", "network_error"],
			["Response", "network_error"],
			["RetryFailed", "network_retry_failed"],
			["Server", "server_error"],
			["Unauthenticated", "unauthenticated"],
			["Walk", "fs_directory_walk_error"]
		]

		for (const [kindValue, expectedKey] of expectedMappings) {
			const result = unwrappedSdkErrorToHumanReadable(fakeError(kindValue))

			expect(result, `ErrorKind value "${kindValue}" should map to ${expectedKey}`).toContain(expectedKey)
		}
	})

	it("maps unhandled SDK ErrorKind variants to error_generic", () => {
		// These variants exist in the SDK published type but have no explicit case in the switch.
		// They MUST fall through to the default: "error_generic" branch.
		const unhandledKindValues = ["FileChunkNotFound", "FileNotFound", "EmailOrPasswordWrong", "Enter2fa", "Wrong2fa"]

		for (const kindValue of unhandledKindValues) {
			const result = unwrappedSdkErrorToHumanReadable(fakeError(kindValue))

			expect(result, `unhandled ErrorKind value "${kindValue}" should fall back to error_generic`).toContain("error_generic")
		}
	})
})
