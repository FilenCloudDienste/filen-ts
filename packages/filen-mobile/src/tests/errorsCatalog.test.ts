import { describe, it, expect } from "vitest"

import { common } from "@/locales/en/common"
import { errors } from "@/locales/en/errors"
import { sort } from "@/locales/en/sort"
import { drive } from "@/locales/en/drive"
import { en } from "@/locales/en"

describe("errors catalog", () => {
	it("exposes one key per SDK error kind plus a generic fallback", () => {
		expect(errors.bad_recovery_key).toBeTypeOf("string")
		expect(errors.directory_not_found).toBeTypeOf("string")
		expect(errors.wrong_password).toBe("Wrong password. Please try again.")
		expect(errors.operation_cancelled).toBeTypeOf("string")
		expect(errors.network_error).toBeTypeOf("string")
		expect(errors.network_retry_failed).toBeTypeOf("string")
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
})

describe("sort catalog", () => {
	it("exposes the fixed notes-group bucket / state labels", () => {
		expect(sort.today).toBe("Today")
		expect(sort.previous_7_days).toBe("Previous 7 days")
		expect(sort.previous_30_days).toBe("Previous 30 days")
		expect(sort.pinned).toBe("Pinned")
		expect(sort.favorited).toBe("Favorited")
		expect(sort.archived).toBe("Archived")
		expect(sort.trashed).toBe("Trashed")
	})

	it("does not define month-name keys (those derive from Intl at runtime)", () => {
		expect(sort).not.toHaveProperty("month_0")
		expect(sort).not.toHaveProperty("tbd_month_0")
	})
})

describe("drive catalog", () => {
	it("exposes the public-link password prompt copy", () => {
		// password_required is a shared key — it lives in common.ts (used by drive + drivePreview)
		expect(common.password_required).toBe("Password required")
		expect(drive).not.toHaveProperty("password_required")
		expect(drive.enter_public_link_directory_password).toBeTypeOf("string")
		expect(drive.enter_public_link_file_password).toBeTypeOf("string")
	})

	it("reuses shared submit/cancel from common and wrong_password from errors", () => {
		expect(common.submit).toBe("Submit")
		expect(common.cancel).toBe("Cancel")
		expect(drive).not.toHaveProperty("submit")
		expect(drive).not.toHaveProperty("cancel")
		expect(drive).not.toHaveProperty("wrong_password")
		expect(errors.wrong_password).toBeTypeOf("string")
	})
})

describe("catalog barrel merge", () => {
	it("merges errors + sort + drive + common into the flat catalog without collisions", () => {
		const commonKeys = Object.keys(common)
		const errorsKeys = Object.keys(errors)
		const sortKeys = Object.keys(sort)
		const driveKeys = Object.keys(drive)
		const all = [...commonKeys, ...errorsKeys, ...sortKeys, ...driveKeys]

		expect(new Set(all).size).toBe(all.length)

		for (const key of all) {
			expect(en).toHaveProperty(key)
		}
	})
})
