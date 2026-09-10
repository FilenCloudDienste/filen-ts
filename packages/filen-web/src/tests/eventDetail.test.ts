import { describe, expect, it } from "vitest"
import type { TFunction } from "i18next"
import type { UserEvent, UserEventFileInfo, UserEventKind } from "@filen/sdk-rs"
import { buildEventDetailRows } from "@/features/settings/lib/eventDetail"

// Identity translator: every key buildEventDetailRows resolves through `t()` in these tests is a
// plain lookup with no interpolation, so returning the key itself is enough to assert "which row
// title got pushed" without pulling in the real i18n catalog.
const t = ((key: string) => key) as unknown as TFunction<"settings">

function event(kind: UserEventKind): UserEvent {
	return { id: 1n, timestamp: 1_700_000_000_000n, uuid: "11111111-1111-1111-1111-111111111111", kind }
}

// The wire fields a file-shaped user event carries beyond ip/userAgent/metadata. buildEventDetailRows
// reads none of them — they only satisfy the payload shape.
const fileEventFields: Omit<UserEventFileInfo, "ip" | "userAgent" | "metadata"> = {
	uuid: "33333333-3333-3333-3333-333333333333",
	stableUuid: "44444444-4444-4444-4444-444444444444",
	newUuid: undefined,
	parent: "55555555-5555-5555-5555-555555555555",
	bucket: "filen-1",
	region: "de-1",
	rm: undefined,
	chunks: 1n,
	version: 1,
	favorited: false,
	timestamp: 1_700_000_000_000n,
	currentUuid: undefined
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
			{ title: "settingsEventDetailIp", value: "1.2.3.4", opaque: true },
			{ title: "settingsEventDetailUserAgent", value: "ua", opaque: true }
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
				oldMetadata: decodedFileMeta("old.txt"),
				uuid: "33333333-3333-3333-3333-333333333333",
				stableUuid: "44444444-4444-4444-4444-444444444444"
			}),
			t
		)

		expect(rows).toContainEqual({ title: "settingsEventDetailName", value: "new.txt" })
		expect(rows).toContainEqual({ title: "settingsEventDetailOldName", value: "old.txt" })
	})

	it("an undecoded (encrypted) file meta falls back to the encrypted label instead of crashing", () => {
		const rows = buildEventDetailRows(
			event({
				type: "fileUploaded",
				ip: "1.2.3.4",
				userAgent: "ua",
				metadata: { type: "encrypted", data: "cipher" },
				...fileEventFields
			}),
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
				value: true,
				uuid: "33333333-3333-3333-3333-333333333333",
				stableUuid: "44444444-4444-4444-4444-444444444444",
				itemType: "folder"
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
				receiverEmail: "friend@example.com",
				uuid: "33333333-3333-3333-3333-333333333333",
				parent: "55555555-5555-5555-5555-555555555555"
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

	it("folderLinkEdited marks the link uuid row opaque, for middle-ellipsis rendering", () => {
		const rows = buildEventDetailRows(
			event({
				type: "folderLinkEdited",
				ip: "1.2.3.4",
				userAgent: "ua",
				linkUuid: "22222222-2222-2222-2222-222222222222",
				uuid: "33333333-3333-3333-3333-333333333333"
			}),
			t
		)

		expect(rows).toContainEqual({
			title: "settingsEventDetailLinkUuid",
			value: "22222222-2222-2222-2222-222222222222",
			opaque: true
		})
	})

	it("a non-opaque row (a resolved name) carries no opaque flag", () => {
		const rows = buildEventDetailRows(
			event({ type: "fileUploaded", ip: "1.2.3.4", userAgent: "ua", metadata: decodedFileMeta("report.pdf"), ...fileEventFields }),
			t
		)

		expect(rows).toContainEqual({ title: "settingsEventDetailName", value: "report.pdf" })
	})
})
