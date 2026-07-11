import { describe, expect, it } from "vitest"
import { validateAvatarFile, AVATAR_MAX_BYTES } from "@/features/settings/components/account/avatarCard.logic"

describe("validateAvatarFile", () => {
	it("accepts a JPEG under the size cap", () => {
		expect(validateAvatarFile({ type: "image/jpeg", size: 1024 })).toEqual({ status: "ok" })
	})

	it("accepts a PNG under the size cap", () => {
		expect(validateAvatarFile({ type: "image/png", size: 1024 })).toEqual({ status: "ok" })
	})

	it("accepts a file exactly at the size cap", () => {
		expect(validateAvatarFile({ type: "image/png", size: AVATAR_MAX_BYTES })).toEqual({ status: "ok" })
	})

	it("rejects an unsupported mime type before checking size", () => {
		expect(validateAvatarFile({ type: "image/gif", size: 1024 })).toEqual({ status: "invalidType" })
	})

	it("rejects a non-image mime type", () => {
		expect(validateAvatarFile({ type: "application/pdf", size: 1024 })).toEqual({ status: "invalidType" })
	})

	it("rejects a file over the size cap", () => {
		expect(validateAvatarFile({ type: "image/jpeg", size: AVATAR_MAX_BYTES + 1 })).toEqual({ status: "tooLarge" })
	})

	it("mime type check is case-insensitive", () => {
		expect(validateAvatarFile({ type: "IMAGE/JPEG", size: 1024 })).toEqual({ status: "ok" })
	})
})
