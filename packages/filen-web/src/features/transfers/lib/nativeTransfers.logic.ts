import type { DesktopTransfer, DesktopTransferError } from "@filen/shared/desktop"
import type { ErrorDTO } from "@/lib/sdk/errors"
import { i18n } from "@/lib/i18n"
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
