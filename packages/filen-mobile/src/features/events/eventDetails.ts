import {
	type UserEvent,
	type UserEventKind,
	type FileMeta,
	type DirMeta,
	FileMeta_Tags,
	DirMeta_Tags,
	UserEventKind_Tags
} from "@filen/sdk-rs"
import { simpleDate } from "@/lib/time"
import i18n from "@/lib/i18n"
import { type TFunction } from "i18next"
import { type en } from "@/locales/en"

// Maps each SDK event kind to a translation key. `satisfies` checks completeness + key validity
// while preserving each value's literal type, so indexing the map yields a narrow key that the
// translator accepts. Callers may pass their own `t` (e.g. the useTranslation() hook in eventInfo)
// so the resolved label stays reactive to an in-app language change; otherwise the module-level
// i18n.t is used for non-React callers.
export const EVENT_KIND_KEY = {
	[UserEventKind_Tags.FileUploaded]: "file_uploaded",
	[UserEventKind_Tags.FileVersioned]: "file_versioned",
	[UserEventKind_Tags.FileRestored]: "file_restored",
	[UserEventKind_Tags.VersionedFileRestored]: "versioned_file_restored",
	[UserEventKind_Tags.FileMoved]: "file_moved",
	[UserEventKind_Tags.FileRenamed]: "file_renamed",
	[UserEventKind_Tags.FileMetadataChanged]: "file_metadata_changed",
	[UserEventKind_Tags.FileTrash]: "file_trash",
	[UserEventKind_Tags.FileRm]: "file_rm",
	[UserEventKind_Tags.FileShared]: "file_shared",
	[UserEventKind_Tags.FileLinkEdited]: "file_link_edited",
	[UserEventKind_Tags.DeleteFilePermanently]: "delete_file_permanently",
	[UserEventKind_Tags.FolderTrash]: "directory_trash",
	[UserEventKind_Tags.FolderShared]: "directory_shared",
	[UserEventKind_Tags.FolderMoved]: "directory_moved",
	[UserEventKind_Tags.FolderRenamed]: "directory_renamed",
	[UserEventKind_Tags.FolderMetadataChanged]: "directory_metadata_changed",
	[UserEventKind_Tags.SubFolderCreated]: "sub_directory_created",
	[UserEventKind_Tags.BaseFolderCreated]: "base_directory_created",
	[UserEventKind_Tags.FolderRestored]: "directory_restored",
	[UserEventKind_Tags.FolderColorChanged]: "directory_color_changed",
	[UserEventKind_Tags.DeleteFolderPermanently]: "delete_directory_permanently",
	[UserEventKind_Tags.FolderLinkEdited]: "directory_link_edited",
	[UserEventKind_Tags.Login]: "login",
	[UserEventKind_Tags.FailedLogin]: "failed_login",
	[UserEventKind_Tags.PasswordChanged]: "password_changed",
	[UserEventKind_Tags.TwoFaEnabled]: "two_fa_enabled",
	[UserEventKind_Tags.TwoFaDisabled]: "two_fa_disabled",
	[UserEventKind_Tags.RequestAccountDeletion]: "request_account_deletion",
	[UserEventKind_Tags.TrashEmptied]: "trash_emptied",
	[UserEventKind_Tags.DeleteAll]: "all_files_deleted",
	[UserEventKind_Tags.DeleteVersioned]: "delete_versioned",
	[UserEventKind_Tags.DeleteUnfinished]: "delete_unfinished",
	[UserEventKind_Tags.CodeRedeemed]: "code_redeemed",
	[UserEventKind_Tags.EmailChanged]: "email_changed",
	[UserEventKind_Tags.EmailChangeAttempt]: "email_change_attempt",
	[UserEventKind_Tags.RemovedSharedInItems]: "removed_shared_in_items",
	[UserEventKind_Tags.RemovedSharedOutItems]: "removed_shared_out_items",
	[UserEventKind_Tags.ItemFavorite]: "item_favorite"
} satisfies Record<UserEventKind_Tags, keyof typeof en>

export function eventKindToReadable(kind: UserEventKind, t: TFunction = i18n.t): string {
	return t(EVENT_KIND_KEY[kind.tag])
}

function extractFileMetaName(meta: FileMeta, t: TFunction): string {
	if (meta.tag === FileMeta_Tags.Decoded) {
		return meta.inner[0].name
	}

	return t("encrypted")
}

function extractDirMetaName(meta: DirMeta, t: TFunction): string {
	if (meta.tag === DirMeta_Tags.Decoded) {
		return meta.inner[0].name
	}

	return t("encrypted")
}

export function buildEventDetails(
	event: UserEvent,
	t: TFunction
): {
	title: string
	value: string
}[] {
	const rows: {
		title: string
		value: string
	}[] = [
		{
			title: t("event_type"),
			value: eventKindToReadable(event.kind, t)
		},
		{
			title: t("timestamp"),
			value: simpleDate(Number(event.timestamp))
		},
		{
			title: t("ip"),
			value: event.kind.inner[0].ip
		},
		{
			title: t("user_agent"),
			value: event.kind.inner[0].userAgent
		}
	]

	switch (event.kind.tag) {
		case UserEventKind_Tags.FileUploaded:
		case UserEventKind_Tags.FileVersioned:
		case UserEventKind_Tags.FileRestored:
		case UserEventKind_Tags.VersionedFileRestored:
		case UserEventKind_Tags.FileMoved:
		case UserEventKind_Tags.FileTrash:
		case UserEventKind_Tags.FileRm:
		case UserEventKind_Tags.FileLinkEdited:
		case UserEventKind_Tags.DeleteFilePermanently: {
			rows.push({
				title: t("name"),
				value: extractFileMetaName(event.kind.inner[0].metadata, t)
			})

			break
		}

		case UserEventKind_Tags.FileRenamed:
		case UserEventKind_Tags.FileMetadataChanged: {
			rows.push({
				title: t("name"),
				value: extractFileMetaName(event.kind.inner[0].metadata, t)
			})

			rows.push({
				title: t("old_name"),
				value: extractFileMetaName(event.kind.inner[0].oldMetadata, t)
			})

			break
		}

		case UserEventKind_Tags.FileShared: {
			rows.push({
				title: t("name"),
				value: extractFileMetaName(event.kind.inner[0].metadata, t)
			})

			rows.push({
				title: t("receiver_email"),
				value: event.kind.inner[0].receiverEmail
			})

			break
		}

		case UserEventKind_Tags.FolderTrash:
		case UserEventKind_Tags.FolderMoved:
		case UserEventKind_Tags.SubFolderCreated:
		case UserEventKind_Tags.BaseFolderCreated:
		case UserEventKind_Tags.FolderRestored:
		case UserEventKind_Tags.FolderColorChanged:
		case UserEventKind_Tags.DeleteFolderPermanently: {
			rows.push({
				title: t("name"),
				value: extractDirMetaName(event.kind.inner[0].name, t)
			})

			break
		}

		case UserEventKind_Tags.FolderRenamed:
		case UserEventKind_Tags.FolderMetadataChanged: {
			rows.push({
				title: t("name"),
				value: extractDirMetaName(event.kind.inner[0].name, t)
			})

			rows.push({
				title: t("old_name"),
				value: extractDirMetaName(event.kind.inner[0].oldName, t)
			})

			break
		}

		case UserEventKind_Tags.FolderShared: {
			rows.push({
				title: t("name"),
				value: extractDirMetaName(event.kind.inner[0].name, t)
			})

			rows.push({
				title: t("receiver_email"),
				value: event.kind.inner[0].receiverEmail
			})

			break
		}

		case UserEventKind_Tags.FolderLinkEdited: {
			rows.push({
				title: t("link_uuid"),
				value: event.kind.inner[0].linkUuid
			})

			break
		}

		case UserEventKind_Tags.CodeRedeemed: {
			rows.push({
				title: t("code"),
				value: event.kind.inner[0].code
			})

			break
		}

		case UserEventKind_Tags.EmailChanged: {
			rows.push({
				title: t("email"),
				value: event.kind.inner[0].email
			})

			break
		}

		case UserEventKind_Tags.EmailChangeAttempt: {
			rows.push({
				title: t("email"),
				value: event.kind.inner[0].email
			})

			rows.push({
				title: t("old_email"),
				value: event.kind.inner[0].oldEmail
			})

			rows.push({
				title: t("new_email"),
				value: event.kind.inner[0].newEmail
			})

			break
		}

		case UserEventKind_Tags.ItemFavorite: {
			rows.push({
				title: t("name"),
				value: extractFileMetaName(event.kind.inner[0].metadata, t)
			})

			rows.push({
				title: t("favorited"),
				value: event.kind.inner[0].value ? t("yes") : t("no")
			})

			break
		}

		case UserEventKind_Tags.RemovedSharedInItems: {
			rows.push({
				title: t("count"),
				value: event.kind.inner[0].count.toString()
			})

			rows.push({
				title: t("sharer_email"),
				value: event.kind.inner[0].sharerEmail
			})

			break
		}

		case UserEventKind_Tags.RemovedSharedOutItems: {
			rows.push({
				title: t("count"),
				value: event.kind.inner[0].count.toString()
			})

			rows.push({
				title: t("receiver_email"),
				value: event.kind.inner[0].receiverEmail
			})

			break
		}

		case UserEventKind_Tags.Login:
		case UserEventKind_Tags.FailedLogin:
		case UserEventKind_Tags.PasswordChanged:
		case UserEventKind_Tags.TwoFaEnabled:
		case UserEventKind_Tags.TwoFaDisabled:
		case UserEventKind_Tags.RequestAccountDeletion:
		case UserEventKind_Tags.TrashEmptied:
		case UserEventKind_Tags.DeleteAll:
		case UserEventKind_Tags.DeleteVersioned:
		case UserEventKind_Tags.DeleteUnfinished: {
			break
		}
	}

	return rows
}
