import * as Comlink from "comlink"
import type { File as SdkFile } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { runOp } from "@/lib/actions/outcome"
import { asErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"
import { narrowItem, upsertDriveItem, type DriveItem } from "@/features/drive/lib/item"
import { driveListingQueryUpdate, fetchDriveItemLinkStatus, driveItemLinkStatusQueryUpdate } from "@/features/drive/queries/drive"
import { createLink } from "@/features/drive/lib/actions"
import { buildPublicLinkUrl } from "@/features/drive/components/linkDialog.logic"
import { useTransfersStore } from "@/features/transfers/store/useTransfersStore"
import { throttle, PROGRESS_THROTTLE_MS } from "@/features/drive/lib/upload"
import { noop } from "@/lib/utils"

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

// Mirrors filen-mobile's chats.ts#getChatUploadsDirectory naming EXACTLY (".filen" then "Chat Uploads",
// nested) — the SAME dedicated directory convention, so a file attached from web and one attached from
// mobile land in the one place. `createDirectory` is idempotent by name under a parent (verified —
// features/drive/lib/createDirectory.ts's own comment: a name clash against an existing DIRECTORY
// returns THAT directory, never errors), so this needs no separate list-then-find step the way mobile's
// uniffi surface does — create IS the find-or-create here. Memoized for the tab's lifetime: every
// attachment after the first skips the two round trips.
let cachedUploadsDirUuid: string | null = null

async function chatUploadsDirUuid(): Promise<string> {
	if (cachedUploadsDirUuid !== null) {
		return cachedUploadsDirUuid
	}

	const dotFilen = await sdkApi.createDirectory(null, ".filen")
	const uploads = await sdkApi.createDirectory(dotFilen.uuid, "Chat Uploads")

	cachedUploadsDirUuid = uploads.uuid

	return uploads.uuid
}

// The shared "item → public link URL" tail, GET-then-CREATE (not blind create): an item the drive
// picker selected may already carry a link from earlier drive use, and re-creating one it already owns
// would be a needless round trip at best — reuse it. `buildPublicLinkUrl` returning null (the item's
// own decrypted key/the link's own linkKey isn't available) is the one case with no SDK error to
// surface, so it gets a plain synthetic one — this should not be reachable for an item this call just
// resolved or uploaded itself, but the outcome type has no "impossible" arm to fall back to instead.
async function ensurePublicLinkUrl(item: DriveItem): Promise<AttachmentOutcome> {
	let existing: Awaited<ReturnType<typeof fetchDriveItemLinkStatus>>

	try {
		existing = await runOp(fetchDriveItemLinkStatus(item))
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	if (existing !== null) {
		driveItemLinkStatusQueryUpdate(item.data.uuid, existing)
		const url = buildPublicLinkUrl(item, existing)

		return url !== null
			? { status: "success", url }
			: { status: "error", dto: asErrorDTO(new Error("chat attachment: existing link carries no usable key")) }
	}

	const outcome = await createLink(item, noop)

	if (outcome.status === "error") {
		return outcome
	}

	const url = buildPublicLinkUrl(item, outcome.link)

	return url !== null
		? { status: "success", url }
		: { status: "error", dto: asErrorDTO(new Error("chat attachment: created link carries no usable key")) }
}

// An EXISTING drive item (the drive-file picker path) — no upload, straight to the shared link tail.
export async function attachExistingDriveItem(item: DriveItem): Promise<AttachmentOutcome> {
	return ensurePublicLinkUrl(item)
}

// A LOCAL file (file-input / drag-drop path): upload into the chat-uploads directory (registered in the
// transfers panel like any other upload, so it shows real progress there — mirrors features/drive/lib/upload.ts's
// runUpload registration exactly, but this needs the resulting DriveItem back to build the link, which
// runUpload's own VoidActionOutcome doesn't carry — a thin sibling rather than a signature change to
// that shared, separately-tested helper), then the shared link tail.
export async function uploadAttachment(file: File, onProgress: (bytesTransferred: number) => void): Promise<AttachmentOutcome> {
	let parentUuid: string

	try {
		parentUuid = await chatUploadsDirUuid()
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

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

	const reportProgress = throttle((bytes: bigint) => {
		const numeric = Number(bytes)
		onProgress(numeric)
		store.setProgress(transferId, numeric)
	}, PROGRESS_THROTTLE_MS)

	let uploaded: SdkFile

	try {
		uploaded = await runOp<SdkFile>(sdkApi.uploadFile(parentUuid, transferId, file, Comlink.proxy(reportProgress)))
	} catch (e) {
		const dto = asErrorDTO(e)

		if (dto.kind === "Cancelled") {
			store.settle(transferId, "cancelled")
			store.remove(transferId)

			return { status: "error", dto }
		}

		store.settle(transferId, "error", dto)

		return { status: "error", dto }
	}

	store.settle(transferId, "done")

	const item = narrowItem(uploaded)
	driveListingQueryUpdate(parentUuid, prev => upsertDriveItem(prev, item))

	return ensurePublicLinkUrl(item)
}
