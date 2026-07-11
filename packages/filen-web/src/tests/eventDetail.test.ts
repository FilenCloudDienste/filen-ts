import { describe, expect, it } from "vitest"
import type { TFunction } from "i18next"
import type { UserEvent, UserEventKind } from "@filen/sdk-rs"
import { buildEventDetailRows } from "@/features/settings/lib/eventDetail"

// Identity translator: every key buildEventDetailRows resolves through `t()` in these tests is a
// plain lookup with no interpolation, so returning the key itself is enough to assert "which row
// title got pushed" without pulling in the real i18n catalog.
const t = ((key: string) => key) as unknown as TFunction<"settings">

function event(kind: UserEventKind): UserEvent {
	return { id: 1n, timestamp: 1_700_000_000_000n, uuid: "11111111-1111-1111-1111-111111111111", kind }
}

function decodedFileMeta(name: string) {
	return { type: "decoded" as const, data: { name, mime: "text/plain", modified: 0n, size: 0n, key: "k", version: 1 as const } }
}

function decodedDirMeta(name: string) {
	return { type: "decoded" as const, data: { name } }
}

describe("buildEventDetailRows", () => {
	it("every kind carries the base ip/userAgent rows", () => {
		const rows = buildEventDetailRows(event({ type: "login", ip: "1.2.3.4", userAgent: "ua" }), t)

		expect(rows).toEqual([
			{ title: "settingsEventDetailIp", value: "1.2.3.4" },
			{ title: "settingsEventDetailUserAgent", value: "ua" }
		])
	})

	it("base-info-only kinds add nothing beyond ip/userAgent", () => {
		const rows = buildEventDetailRows(event({ type: "passwordChanged", ip: "1.2.3.4", userAgent: "ua" }), t)

		expect(rows).toHaveLength(2)
	})

	it("a rename kind adds both the current and previous name", () => {
		const rows = buildEventDetailRows(
			event({
				type: "fileRenamed",
				ip: "1.2.3.4",
				userAgent: "ua",
				metadata: decodedFileMeta("new.txt"),
				oldMetadata: decodedFileMeta("old.txt")
			}),
			t
		)

		expect(rows).toContainEqual({ title: "settingsEventDetailName", value: "new.txt" })
		expect(rows).toContainEqual({ title: "settingsEventDetailOldName", value: "old.txt" })
	})

	it("an undecoded (encrypted) file meta falls back to the encrypted label instead of crashing", () => {
		const rows = buildEventDetailRows(
			event({ type: "fileUploaded", ip: "1.2.3.4", userAgent: "ua", metadata: { type: "encrypted", data: "cipher" } }),
			t
		)

		expect(rows).toContainEqual({ title: "settingsEventDetailName", value: "settingsEventDetailEncrypted" })
	})

	it("a folder favorited as decryptedUTF8 raw JSON still resolves its name", () => {
		const rows = buildEventDetailRows(
			event({
				type: "itemFavorite",
				ip: "1.2.3.4",
				userAgent: "ua",
				metadata: { type: "decryptedUTF8", data: JSON.stringify({ name: "My Folder" }) },
				value: true
			}),
			t
		)

		expect(rows).toContainEqual({ title: "settingsEventDetailName", value: "My Folder" })
		expect(rows).toContainEqual({ title: "settingsEventDetailFavorited", value: "settingsEventDetailYes" })
	})

	it("folderShared adds the directory name and receiver email", () => {
		const rows = buildEventDetailRows(
			event({
				type: "folderShared",
				ip: "1.2.3.4",
				userAgent: "ua",
				name: decodedDirMeta("Shared Dir"),
				receiverEmail: "friend@example.com"
			}),
			t
		)

		expect(rows).toContainEqual({ title: "settingsEventDetailName", value: "Shared Dir" })
		expect(rows).toContainEqual({ title: "settingsEventDetailReceiverEmail", value: "friend@example.com" })
	})

	it("removedSharedInItems adds the count and sharer email", () => {
		const rows = buildEventDetailRows(
			event({ type: "removedSharedInItems", ip: "1.2.3.4", userAgent: "ua", count: 3n, sharerEmail: "sharer@example.com" }),
			t
		)

		expect(rows).toContainEqual({ title: "settingsEventDetailCount", value: "3" })
		expect(rows).toContainEqual({ title: "settingsEventDetailSharerEmail", value: "sharer@example.com" })
	})

	it("emailChangeAttempt adds email, oldEmail and newEmail", () => {
		const rows = buildEventDetailRows(
			event({
				type: "emailChangeAttempt",
				ip: "1.2.3.4",
				userAgent: "ua",
				email: "current@example.com",
				oldEmail: "old@example.com",
				newEmail: "new@example.com"
			}),
			t
		)

		expect(rows).toContainEqual({ title: "settingsEventDetailEmail", value: "current@example.com" })
		expect(rows).toContainEqual({ title: "settingsEventDetailOldEmail", value: "old@example.com" })
		expect(rows).toContainEqual({ title: "settingsEventDetailNewEmail", value: "new@example.com" })
	})
})
