import type { File as SdkFile } from "@filen/sdk-rs"
import { DOT_FILEN_SUBDIRS, extensionStart, sumBytes } from "@filen/shared"
import { sdkApi } from "@/lib/sdk/client"
import { attemptOp, runOp } from "@/lib/actions/outcome"
import { asErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"
import { narrowItem, upsertDriveItem, type DriveItem } from "@/features/drive/lib/item"
import {
	driveListingQueryUpdate,
	fetchDriveItemLinkStatus,
	driveItemLinkStatusQueryUpdate,
	type DriveItemLinkStatus
} from "@/features/drive/queries/drive"
import { createLink } from "@/features/drive/lib/actions"
import { buildPublicLinkUrl } from "@/features/drive/components/linkDialog.logic"
import { useTransfersStore } from "@/features/transfers/store/useTransfersStore"
import { settleTransferFailure } from "@/features/transfers/lib/settle"
import { onTransferProgress, openProgressChannel } from "@/features/transfers/lib/progressChannel"
import { noop } from "@/lib/utils"
import { getDotFilenSubdir } from "@/lib/dotFilen"
import { markAccountStale } from "@/queries/account"
import { addAccountStorageUsed, ensureUploadQuota } from "@/features/drive/lib/quota"

// Composer attachment flow: no first-class attachment message type
// on either mobile or old-web — attachments are Filen public links pasted into the message body. A
// LOCAL file (file-input / drag-drop) uploads into a dedicated directory then gets a public link; an
// EXISTING drive item (the drive-file picker) skips the upload and just gets/reuses its link. Both
// converge on the same public-link-url text the composer inserts. Every step is a plain confirm-then-
// patch call (queries/client.ts convention) — no outbox, no retry logic of our own (the SDK's Tower
// stack owns upload retries; a link-creation failure is surfaced once, not auto-retried).
//
// PREMIUM GATE (binding context — the shared e2e account is FREE): `createFileLink`/`createDirectoryLink`
// reject on a free account with the server's own error. That rejection is NOT special-cased here — it
// flows through the exact same asErrorDTO → errorLabel path as any other failure, so the composer shows
// whatever label the server sent (LABEL-FIRST, lib/sdk/errors.ts's own rule) rather than a bespoke
// "upgrade to premium" message this app doesn't otherwise author.

export type AttachmentOutcome = { status: "success"; url: string } | { status: "error"; dto: ErrorDTO }

// The same `.filen/chat-uploads` filen-mobile's chats.ts#getChatUploadsDirectory resolves (DOT_FILEN_SUBDIRS), so a
// file attached from web and one attached from mobile land in the one place. Resolved once
// per session through the shared `.filen` resolver, so a multi-file pick's concurrent uploads share one
// lookup; logout drops it (resetDotFilen), since its uuid names a directory the next account cannot write to.
const CHAT_UPLOADS_DIR_NAME = DOT_FILEN_SUBDIRS.chatUploads

let lastAttachmentStamp = 0

// The name an attachment uploads under — mobile's `${name}.${Date.now()}${ext}` — so every upload is a
// brand-new file: a repeated name (image.png from a paste) would otherwise version the earlier
// attachment whose link is already posted in a chat. The stamp only ever increases, since a multi-file
// pick names all its uploads within one millisecond. A leading or trailing dot is not an extension.
function uniqueAttachmentName(name: string): string {
	lastAttachmentStamp = Math.max(Date.now(), lastAttachmentStamp + 1)

	const dot = extensionStart(name)
	const ext = dot === -1 ? "" : name.slice(dot)

	return `${name.slice(0, name.length - ext.length)}.${String(lastAttachmentStamp)}${ext}`
}

function linkUrlOutcome(item: DriveItem, link: DriveItemLinkStatus, which: "created" | "existing"): AttachmentOutcome {
	const url = buildPublicLinkUrl(item, link)

	return url !== null
		? { status: "success", url }
		: { status: "error", dto: asErrorDTO(new Error(`chat attachment: ${which} link carries no usable key`)) }
}

// Creates the item's link and builds its url. `buildPublicLinkUrl` returning null (the item's own
// decrypted key/the link's own linkKey isn't available) is the one case with no SDK error to surface, so
// it gets a plain synthetic one — this should not be reachable for an item this call just resolved or
// uploaded itself, but the outcome type has no "impossible" arm to fall back to instead.
async function createPublicLinkUrl(item: DriveItem): Promise<AttachmentOutcome> {
	const outcome = await createLink(item, noop)

	if (outcome.status === "error") {
		return outcome
	}

	return linkUrlOutcome(item, outcome.link, "created")
}

// GET-then-CREATE (not blind create) for an item the drive picker selected: it may already carry a link
// from earlier drive use, and re-creating one it already owns would be a needless round trip at best —
// reuse it.
async function ensurePublicLinkUrl(item: DriveItem): Promise<AttachmentOutcome> {
	const outcome = await attemptOp(fetchDriveItemLinkStatus(item))

	if (outcome.status === "error") {
		return outcome
	}

	const existing = outcome.item

	if (existing !== null) {
		driveItemLinkStatusQueryUpdate(item.data.uuid, existing)

		return linkUrlOutcome(item, existing, "existing")
	}

	return createPublicLinkUrl(item)
}

// An EXISTING drive item (the drive-file picker path) — no upload, straight to the get-or-create link tail.
export async function attachExistingDriveItem(item: DriveItem): Promise<AttachmentOutcome> {
	return ensurePublicLinkUrl(item)
}

// The quota pre-flight for a whole local pick, run once before any of its uploadAttachment calls: the
// pick is blocked as a whole (one message, nothing created) like a drive upload. False once refused.
export function preflightAttachments(files: readonly File[]): Promise<boolean> {
	return ensureUploadQuota(sumBytes(files.map(file => file.size)))
}

// A LOCAL file (file-input / drag-drop path): upload into the chat-uploads directory (registered in the
// transfers panel like any other upload, so it shows real progress there — mirrors features/drive/lib/upload.ts's
// runUpload registration exactly, but this needs the resulting DriveItem back to build the link, which
// runUpload's own VoidActionOutcome doesn't carry — a thin sibling rather than a signature change to
// that shared, separately-tested helper), then a straight link create: the upload is a fresh file under
// a unique name, so it cannot already carry a link and the status read would be a wasted round trip.
export async function uploadAttachment(file: File, onProgress: (bytesTransferred: number) => void): Promise<AttachmentOutcome> {
	const parent = await attemptOp(getDotFilenSubdir(CHAT_UPLOADS_DIR_NAME))

	if (parent.status === "error") {
		return parent
	}

	const parentUuid = parent.item

	const transferId = crypto.randomUUID()
	const store = useTransfersStore.getState()

	store.add({
		id: transferId,
		direction: "upload",
		name: file.name,
		size: file.size,
		bytesTransferred: 0,
		status: "uploading",
		parentUuid,
		startedAt: Date.now()
	})

	// The row's bytes come through the worker's progress channel; the composer follows them too.
	const stopFollowing = onTransferProgress(transferId, onProgress)

	let uploaded: SdkFile
	// Wraps the same bytes (no copy) under the unique name.
	const named = new File([file], uniqueAttachmentName(file.name), { type: file.type, lastModified: file.lastModified })

	openProgressChannel()

	try {
		uploaded = await runOp<SdkFile>(sdkApi.uploadFile(parentUuid, transferId, named))
	} catch (e) {
		const dto = asErrorDTO(e)

		settleTransferFailure(store, transferId, dto)

		return { status: "error", dto }
	} finally {
		stopFollowing()
	}

	store.settle(transferId, "done")

	const item = narrowItem(uploaded)
	driveListingQueryUpdate(parentUuid, prev => upsertDriveItem(prev, item))
	markAccountStale()
	addAccountStorageUsed(uploaded.size)

	return createPublicLinkUrl(item)
}
