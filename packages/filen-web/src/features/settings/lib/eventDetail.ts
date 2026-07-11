import type { TFunction } from "i18next"
import type { UserEvent, FileMeta, DirMeta } from "@filen/sdk-rs"

export interface EventDetailRow {
	title: string
	value: string
}

// Mirrors filen-mobile's eventDetails.ts extractFileMetaName, adapted to the wasm shape's lowercase
// `type` discriminant ("decoded"/"decryptedUTF8"/…, vs mobile's Tags enum). A favorited FOLDER arrives
// as FileMeta "decryptedUTF8" (raw JSON — the folder meta schema doesn't match the file one), so that
// arm is parsed for a `name` field before falling back to the encrypted label.
function extractFileMetaName(meta: FileMeta, t: TFunction<"settings">): string {
	if (meta.type === "decoded") {
		return meta.data.name
	}

	if (meta.type === "decryptedUTF8") {
		try {
			const parsed: unknown = JSON.parse(meta.data)

			if (typeof parsed === "object" && parsed !== null && "name" in parsed && typeof parsed.name === "string") {
				return parsed.name
			}
		} catch {
			// Not parseable JSON — fall through to the encrypted label.
		}
	}

	return t("settingsEventDetailEncrypted")
}

function extractDirMetaName(meta: DirMeta, t: TFunction<"settings">): string {
	return meta.type === "decoded" ? meta.data.name : t("settingsEventDetailEncrypted")
}

// Per-kind extra rows beyond the base ip/userAgent pair every UserEventKind arm carries (accessible
// without narrowing — UserEventBaseInfo's fields are common to every union member). getUserEvent(uuid)
// returns this exact same UserEvent shape, so this dialog reuses the already-fetched list row's event
// object rather than issuing a second network call — there is no extra information getUserEvent(uuid)
// would add.
export function buildEventDetailRows(event: UserEvent, t: TFunction<"settings">): EventDetailRow[] {
	const rows: EventDetailRow[] = [
		{ title: t("settingsEventDetailIp"), value: event.kind.ip },
		{ title: t("settingsEventDetailUserAgent"), value: event.kind.userAgent }
	]

	const kind = event.kind

	switch (kind.type) {
		case "fileUploaded":
		case "fileVersioned":
		case "fileRestored":
		case "versionedFileRestored":
		case "fileMoved":
		case "fileTrash":
		case "fileRm":
		case "fileLinkEdited":
		case "deleteFilePermanently":
			rows.push({ title: t("settingsEventDetailName"), value: extractFileMetaName(kind.metadata, t) })
			break

		case "fileRenamed":
		case "fileMetadataChanged":
			rows.push({ title: t("settingsEventDetailName"), value: extractFileMetaName(kind.metadata, t) })
			rows.push({ title: t("settingsEventDetailOldName"), value: extractFileMetaName(kind.oldMetadata, t) })
			break

		case "fileShared":
			rows.push({ title: t("settingsEventDetailName"), value: extractFileMetaName(kind.metadata, t) })
			rows.push({ title: t("settingsEventDetailReceiverEmail"), value: kind.receiverEmail })
			break

		case "folderTrash":
		case "folderMoved":
		case "subFolderCreated":
		case "baseFolderCreated":
		case "folderRestored":
		case "folderColorChanged":
		case "deleteFolderPermanently":
			rows.push({ title: t("settingsEventDetailName"), value: extractDirMetaName(kind.name, t) })
			break

		case "folderRenamed":
		case "folderMetadataChanged":
			rows.push({ title: t("settingsEventDetailName"), value: extractDirMetaName(kind.name, t) })
			rows.push({ title: t("settingsEventDetailOldName"), value: extractDirMetaName(kind.oldName, t) })
			break

		case "folderShared":
			rows.push({ title: t("settingsEventDetailName"), value: extractDirMetaName(kind.name, t) })
			rows.push({ title: t("settingsEventDetailReceiverEmail"), value: kind.receiverEmail })
			break

		case "folderLinkEdited":
			rows.push({ title: t("settingsEventDetailLinkUuid"), value: kind.linkUuid })
			break

		case "codeRedeemed":
			rows.push({ title: t("settingsEventDetailCode"), value: kind.code })
			break

		case "emailChanged":
			rows.push({ title: t("settingsEventDetailEmail"), value: kind.email })
			break

		case "emailChangeAttempt":
			rows.push({ title: t("settingsEventDetailEmail"), value: kind.email })
			rows.push({ title: t("settingsEventDetailOldEmail"), value: kind.oldEmail })
			rows.push({ title: t("settingsEventDetailNewEmail"), value: kind.newEmail })
			break

		case "itemFavorite":
			rows.push({ title: t("settingsEventDetailName"), value: extractFileMetaName(kind.metadata, t) })
			rows.push({
				title: t("settingsEventDetailFavorited"),
				value: kind.value ? t("settingsEventDetailYes") : t("settingsEventDetailNo")
			})
			break

		case "removedSharedInItems":
			rows.push({ title: t("settingsEventDetailCount"), value: kind.count.toString() })
			rows.push({ title: t("settingsEventDetailSharerEmail"), value: kind.sharerEmail })
			break

		case "removedSharedOutItems":
			rows.push({ title: t("settingsEventDetailCount"), value: kind.count.toString() })
			rows.push({ title: t("settingsEventDetailReceiverEmail"), value: kind.receiverEmail })
			break

		// Base-info-only kinds: ip/userAgent above is the whole story, nothing further to add.
		case "login":
		case "failedLogin":
		case "passwordChanged":
		case "twoFaEnabled":
		case "twoFaDisabled":
		case "requestAccountDeletion":
		case "trashEmptied":
		case "deleteAll":
		case "deleteVersioned":
		case "deleteUnfinished":
			break
	}

	return rows
}
