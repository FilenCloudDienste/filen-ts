import * as Comlink from "comlink"
import type { File as SdkFile } from "@filen/sdk-rs"
import { sumBytes } from "@filen/shared"
import { sdkApi } from "@/lib/sdk/client"
import { runOp } from "@/lib/actions/outcome"
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
import { throttle, PROGRESS_THROTTLE_MS } from "@/features/drive/lib/upload"
import { noop } from "@/lib/utils"
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

// Mirrors filen-mobile's chats.ts#getChatUploadsDirectory naming EXACTLY (".filen" then "Chat Uploads",
// nested) — the SAME dedicated directory convention, so a file attached from web and one attached from
// mobile land in the one place. `createDirectory` is idempotent by name under a parent (verified —
// features/drive/lib/createDirectory.ts's own comment: a name clash against an existing DIRECTORY
// returns THAT directory, never errors), so this needs no separate list-then-find step the way mobile's
// uniffi surface does — create IS the find-or-create here. Memoized for the tab's lifetime as the
// PROMISE, so a multi-file pick's concurrent uploads share one lookup instead of each creating the pair.
let uploadsDirPromise: Promise<string> | null = null

// The memo above is keyed on nothing but the tab, so it MUST be dropped when the account behind it
// changes: a uuid minted under the signed-out account names a directory the next one cannot write to,
// and every attachment would upload into a directory that is not theirs until the tab reloaded.
// performLogout calls this alongside its other per-session teardowns. A lookup still in flight keeps
// resolving for its own callers only; it can no longer re-seed the memo.
export function resetChatUploadsDirCache(): void {
	uploadsDirPromise = null
}

function chatUploadsDirUuid(): Promise<string> {
	if (uploadsDirPromise !== null) {
		return uploadsDirPromise
	}

	const promise = (async () => {
		const dotFilen = await sdkApi.createDirectory(null, ".filen")
		const uploads = await sdkApi.createDirectory(dotFilen.uuid, "Chat Uploads")

		return uploads.uuid
	})()

	uploadsDirPromise = promise

	// A failure is not memoized: the next attachment tries again.
	promise.catch(() => {
		if (uploadsDirPromise === promise) {
			uploadsDirPromise = null
		}
	})

	return promise
}

let lastAttachmentStamp = 0

// The name an attachment uploads under — mobile's `${name}.${Date.now()}${ext}` — so every upload is a
// brand-new file: a repeated name (image.png from a paste) would otherwise version the earlier
// attachment whose link is already posted in a chat. The stamp only ever increases, since a multi-file
// pick names all its uploads within one millisecond. A leading or trailing dot is not an extension.
function uniqueAttachmentName(name: string): string {
	lastAttachmentStamp = Math.max(Date.now(), lastAttachmentStamp + 1)

	const dot = name.lastIndexOf(".")
	const ext = dot > 0 && dot < name.length - 1 ? name.slice(dot) : ""

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
	let existing: DriveItemLinkStatus | null

	try {
		existing = await runOp(fetchDriveItemLinkStatus(item))
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

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
	// Wraps the same bytes (no copy) under the unique name.
	const named = new File([file], uniqueAttachmentName(file.name), { type: file.type, lastModified: file.lastModified })

	try {
		uploaded = await runOp<SdkFile>(sdkApi.uploadFile(parentUuid, transferId, named, Comlink.proxy(reportProgress)))
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
	markAccountStale()
	addAccountStorageUsed(uploaded.size)

	return createPublicLinkUrl(item)
}
