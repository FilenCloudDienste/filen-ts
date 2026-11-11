import type { Dir, File as SdkFile } from "@filen/sdk-rs"
import type {
	DesktopDownloadItem,
	DesktopSdkRef,
	DesktopSdkVariant,
	DesktopTransfer,
	DesktopTransferError,
	DesktopUploadParent
} from "@filen/shared/desktop"
import { stringifyEnvelope } from "@filen/shared/session"
import { driveItemName } from "@filen/shared"
import type { ErrorDTO } from "@/lib/sdk/errors"
import { i18n } from "@/lib/i18n"
import { toAnyDirWithContext, type DriveItem } from "@/features/drive/lib/item"
import type { Transfer, UploadBatchRef } from "@/features/transfers/store/useTransfersStore"

// A row of the desktop app's native host as the transfers store holds it. `batch`: the upload run it belongs to.
export function rowOf(transfer: DesktopTransfer, batch: UploadBatchRef | undefined): Omit<Transfer, "paused"> {
	const upload = transfer.direction === "upload"

	return {
		id: transfer.id,
		direction: transfer.direction,
		name: transfer.name,
		size: transfer.size,
		bytesTransferred: transfer.bytes,
		status: upload ? "uploading" : "downloading",
		parentUuid: upload ? transfer.parentUuid : null,
		startedAt: transfer.startedAt,
		native: true,
		...(transfer.revealable ? { revealable: true as const } : {}),
		...(batch === undefined ? {} : { batch })
	}
}

// What a code says, where neither the SDK's kind nor the server says more.
function codeLabel(error: DesktopTransferError): string | undefined {
	switch (error.code) {
		case "interrupted":
		case "hostUnavailable":
			return i18n.t("transfers:transfersNativeInterrupted")
		case "localMissing":
			return i18n.t("transfers:transfersNativeLocalMissing")
		case "localDenied":
			return i18n.t("transfers:transfersNativeLocalDenied")
		case "localFull":
			return i18n.t("transfers:transfersNativeLocalFull")
		case "localInUse":
			return i18n.t("transfers:transfersNativeLocalInUse")
		default:
			return undefined
	}
}

// The SDK kind a code stands for, so errorLabel and the storage check read it as they read the page's own errors.
function kindOf(error: DesktopTransferError): string | undefined {
	switch (error.code) {
		case "storageFull":
			return "MaxStorageReached"
		case "unauthenticated":
			return "Unauthenticated"
		case "timeout":
		case "invalidItem":
		case "unknown":
			return error.kind ?? "Internal"
		default:
			return undefined
	}
}

// A native transfer's error as the page's rows carry one (errorLabel reads a code's own text from `message`).
export function errorDtoOf(error: DesktopTransferError): ErrorDTO {
	const kind = kindOf(error)
	const message = codeLabel(error) ?? error.message ?? error.code

	return { species: "plain", ...(kind === undefined ? {} : { kind }), label: message, message }
}

function refOf(variant: DesktopSdkVariant, value: unknown): DesktopSdkRef {
	return { variant, value: stringifyEnvelope(value) }
}

// The SDK's own fields of an item's File or Dir, without what the page added to it (its ExtraData and decrypted
// meta): the host's converter takes exactly these.
function sdkFileOf(data: SdkFile): SdkFile {
	const { uuid, stableUUID, meta, parent, size, favorited, region, bucket, timestamp, chunks, canMakeThumbnail } = data

	return { uuid, stableUUID, meta, parent, size, favorited, region, bucket, timestamp, chunks, canMakeThumbnail }
}

function sdkDirOf(data: Dir): Dir {
	const { uuid, parent, color, timestamp, favorited, meta } = data

	return { uuid, parent, color, timestamp, favorited, meta }
}

// An item as the host downloads it, its variant named from the item's drive type. A nested shared file is a plain
// File the listing spread a role onto; a shared directory takes its share's context. Throws for a nested shared
// directory without its role (toAnyDirWithContext).
export function downloadItemOf(item: DriveItem): DesktopDownloadItem {
	const name = driveItemName(item)
	const size = Number(item.data.size)

	switch (item.type) {
		case "file":
		case "sharedFile":
			return { kind: "file", ref: refOf("AnyFile.File", sdkFileOf(item.data)), name, size }
		case "sharedRootFile":
			return { kind: "file", ref: refOf("AnyFile.Shared", item.data.shareSource), name, size }
		case "directory":
			return { kind: "directory", ref: refOf("AnyDirWithContext.Normal.Dir", sdkDirOf(item.data)), name, size }
		case "sharedDirectory":
			return { kind: "directory", ref: refOf("AnyDirWithContext.Shared.Dir", toAnyDirWithContext(item)), name, size }
		case "sharedRootDirectory":
			return { kind: "directory", ref: refOf("AnyDirWithContext.Shared.Root", toAnyDirWithContext(item)), name, size }
	}
}

// The directory `uuid` as an upload's parent: the Dir a listing holds, else a uuid-only Root (the SDK reads only a
// parent's uuid there, as the page's worker does, workers/parentDir.ts), so no request.
export function uploadParentOf(uuid: string, held: DriveItem | undefined): DesktopUploadParent {
	return held?.type === "directory" && held.data.uuid === uuid
		? { uuid, ref: refOf("AnyNormalDir.Dir", sdkDirOf(held.data)) }
		: { uuid, ref: refOf("AnyNormalDir.Root", { uuid }) }
}
