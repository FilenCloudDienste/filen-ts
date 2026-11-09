import * as Comlink from "comlink"
import type { File as SdkFile } from "@filen/sdk-rs"
import type { DriveFileRef, PortLike, SaveResult } from "@filen/office/dom/presentation"
import { savePortAnnounced } from "@filen/office/dom/presentation/savePort"
import { driveItemName, type QuotaVerdict } from "@filen/shared"
import { asDirectoryOrFile, narrowItem, upsertDriveItem, type DriveItem } from "@/features/drive/lib/item"
import { extensionOf, previewType, type PreviewCategory } from "@/features/drive/lib/preview.logic"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { isEditableSpreadsheetExtension } from "@/features/spreadsheet/lib/fileKind"
import { isEditablePresentationExtension } from "@/features/presentation/lib/fileKind"
import { inPlaceFormatByName } from "@/features/preview/imageEdit/lib/targets"
import type { Orientation } from "@/features/preview/imageEdit/types"
import { captureTimestamp } from "@/features/photos/lib/captureSort"
import { runOp, type ActionOutcome } from "@/lib/actions/outcome"
import type { PreviewKey } from "@/lib/i18n"
import { asErrorDTO, plainErrorDTO, PARENT_NOT_FOUND_PREFIX, type ErrorDTO } from "@/lib/sdk/errors"
import { checkUploadQuota, quotaExceededMessage } from "@/features/drive/lib/quota"

// Editable-preview eligibility gate (mobile parity): only a decryptable text/code/markdown file, spreadsheet, Word document, deck or image
// inside the navigable "drive" variant — never trash/recents/favorites/sharedIn/sharedOut (no
// writable parent context, or a variant this app never lets a write reach), never an undecryptable
// row (nothing to encode a diff against). Markdown is edited through the viewer's own source mode,
// which mounts the same CodeMirror surface text/code use; its rendered arm is never an editing
// surface.
// Whether a new file may be written beside this one (a converted copy): any readable file in the user's
// own drive, whatever its format — unlike isEditable, which also needs the file's own format to save.
export function canSaveCopyBeside(item: DriveItem, variant: DriveVariant): boolean {
	const base = asDirectoryOrFile(item)

	return variant === "drive" && base.type === "file" && !base.data.undecryptable
}

// A save an editor refused before anything was uploaded (its own check of the file it wrote failed); the
// edits stay unsaved and the message key says why. `action` is what the user can do about it (keep the
// edits some other way), shown with the message; `silent`: the editor shows it itself (an autosave).
export class SaveRefusedError extends Error {
	readonly messageKey: PreviewKey
	readonly action: { readonly labelKey: PreviewKey; readonly run: () => void } | undefined
	readonly silent: boolean

	constructor(
		messageKey: PreviewKey,
		options: { action?: { readonly labelKey: PreviewKey; readonly run: () => void }; silent?: boolean } = {}
	) {
		super(messageKey)
		this.name = "SaveRefusedError"
		this.messageKey = messageKey
		this.action = options.action
		this.silent = options.silent === true
	}
}

// RTF and OpenDocument text (and its templates) edit as the package they read as and save in their own format (the
// lossless RTF and ODT writers).
const DOCX_EDITABLE_EXTENSIONS: ReadonlySet<string> = new Set(["docx", "docm", "dotx", "dotm", "rtf", "odt", "ott"])

export function isEditable(item: DriveItem, variant: DriveVariant): boolean {
	if (variant !== "drive") {
		return false
	}

	const base = asDirectoryOrFile(item)

	if (base.type !== "file" || base.data.undecryptable) {
		return false
	}

	const category = previewType(item)

	// A spreadsheet edits in its grid, and saves in the format its extension names; a legacy .xls, or one
	// known only by its mime type, only opens to be looked at.
	if (category === "spreadsheet") {
		return isEditableSpreadsheetExtension(extensionOf(driveItemName(base)))
	}

	// A Word document edits on its pages: a document or template, macro-enabled or not (macros are kept byte for byte and never run; the writer
	// keeps the file's content type), an RTF document, or an OpenDocument text document or template (its mimetype kept).
	if (category === "docx") {
		return DOCX_EDITABLE_EXTENSIONS.has(extensionOf(driveItemName(base)))
	}

	// A deck, template or show (OOXML or OpenDocument) saves as itself; a 97–2003 deck only opens to be looked at.
	if (category === "presentation") {
		return isEditablePresentationExtension(extensionOf(driveItemName(base)))
	}

	// An image saves in place only in a format its name says the editor writes; by name alone, as a rename's
	// re-check must agree with the slot's pin without a probe. Other images edit into a copy (canEditImage).
	if (category === "image") {
		return inPlaceFormatByName(driveItemName(base)) !== null
	}

	return isTextCategory(category)
}

// Whether the preview offers the image editor: any decodable still in the user's own drive, saved in place or, for
// a format the editor cannot write, as a copy beside it. Never an SVG (markup, not pixels) or a camera RAW.
export function canEditImage(item: DriveItem, variant: DriveVariant): boolean {
	if (variant !== "drive") {
		return false
	}

	const base = asDirectoryOrFile(item)

	if (base.type !== "file" || base.data.undecryptable || previewType(item) !== "image") {
		return false
	}

	return extensionOf(driveItemName(base)) !== "svg" && base.data.decryptedMeta?.mime !== "image/svg+xml"
}

// Whether the preview is text an editor holds as a string (a line diff can compare two versions of it).
export function isTextCategory(category: PreviewCategory): boolean {
	return category === "text" || category === "code" || category === "markdown"
}

// Injected collaborators so a save attempt is unit-testable without a worker or a query client —
// mirrors RunUploadDeps (features/drive/lib/upload.ts)/CreateDirectoryDeps (createDirectory.ts). `patchListing`
// matches driveListingQueryUpdate's own (parentUuid, updater) shape (queries/drive.ts) rather than the
// global fan-out variant: a save never changes the item's parent, so exactly one listing can ever gain
// or lose a row from it — the single-parent patch is the one that can never leak a phantom row into an
// unrelated, already-cached listing (see upsertDriveItem's own unconditional-append behavior).
// The new file's times, and that the image's own Exif dates must not replace them.
export interface UploadTimes {
	created?: bigint
	modified?: bigint
	noExifOverride?: boolean
}

export interface PreviewSaveDeps {
	uploadFileBytes: (parentUuid: string | null, data: Uint8Array, name: string, mime: string, options: UploadTimes) => Promise<SdkFile>
	// A save streamed over a port (a presentation's: the worker writes, the SDK worker uploads as it reads).
	uploadFileFromPort?: (
		parentUuid: string | null,
		port: MessagePort,
		name: string,
		mime: string,
		options: UploadTimes & { size?: number }
	) => Promise<SdkFile>
	// A Blob the SDK worker streams itself (an edited image): the Blob crosses by reference, its bytes are never copied here.
	uploadFileBlob?: (parentUuid: string | null, blob: Blob, name: string, mime: string, options: UploadTimes) => Promise<SdkFile>
	// A JPEG only turned or flipped: `file` streamed back with its Exif Orientation rewritten (sdk.worker.ts's
	// rewriteJpegOrientation), never re-encoded.
	rewriteOrientation?: (
		file: SdkFile,
		orientation: Orientation,
		parentUuid: string | null,
		name: string,
		mime: string,
		options: UploadTimes
	) => Promise<SdkFile>
	// `writeNow`: the listing reaches disk at once, not after its patches pause (a reload right after a save
	// would otherwise restore the row naming the version it replaced).
	patchListing: (parentUuid: string | null, updater: (items: DriveItem[]) => DriveItem[], options: { readonly writeNow: boolean }) => void
	// The storage pre-flight; left out, the account's (checkUploadQuota). Every save, copy and converted copy runs
	// through here, so this is the one place it is made.
	checkQuota?: (neededBytes: bigint) => Promise<QuotaVerdict>
	// The account's own root uuid — a real Dir.parent is never null (see sdk.worker.ts's own
	// ListDirectoryTarget comment), so a root-level item's parent must collapse back to the `null`
	// sentinel before it can resolve worker-side (resolveNormalDirParent) or key the right listing.
	rootUuid: string
}

function dropUuid(items: DriveItem[], uuid: string): DriveItem[] {
	return items.filter(existing => existing.data.uuid !== uuid)
}

// One save attempt: encode the edited buffer, transfer it into the worker's whole-buffer uploadFileBytes
// op (never cloned), then patch the item's own listing for the ROTATED uuid a content change always
// produces — mirrors restoreVersion's identical uuid-rotation reconcile (features/drive/lib/actions.ts):
// upsertDriveItem's name-collision dedup already drops the stale row (same parent, same name), and the
// explicit dropUuid below is the same defense-in-depth restoreVersion applies for a row whose meta
// isn't decodable enough to match on name alone. Never throws — a worker rejection comes back as an
// error outcome; the caller (previewOverlay.tsx) degrades the editor to read-only ONLY for the one
// class isUnresolvableParentError below identifies (e.g. the containing directory was deleted from
// another session mid-edit) — retrying against a parent that will only ever fail again is pointless
// (mobile parity). Every other rejection leaves the buffer editable for a retry.
//
// `asNewFile` writes the buffer beside the file under that name instead (a copy of unsaved edits the
// file itself moved on from, or of a file deleted meanwhile), leaving the file's own row alone. The name
// must be free: the same upload onto a taken name would make a new version of that file.
// What a save uploads: text, bytes, a port a worker writes the file to (never held whole on the page), a Blob, or the
// file itself with a new Exif Orientation.
export type PreviewSaveContent =
	| string
	| Uint8Array
	| { readonly port: MessagePort; readonly size?: number }
	| { readonly blob: Blob }
	| { readonly orientation: Orientation }

// `times`: the new file's (an edited image keeps the original's creation time; its Exif never overrides them).
// `mime`: instead of the file's own, "" letting the SDK take it from the name (a copy in another format).
export async function runPreviewSave(
	deps: PreviewSaveDeps,
	args: {
		item: DriveItem
		content: PreviewSaveContent
		asNewFile?: string
		times?: { created?: bigint; modified?: bigint }
		mime?: string
	}
): Promise<ActionOutcome<DriveItem>> {
	const { item, content, asNewFile, times } = args
	const base = asDirectoryOrFile(item)

	if (base.type !== "file") {
		// Unreachable in practice — isEditable already excludes every non-file arm — kept so the
		// narrow below (decryptedMeta.mime is file-arm-only) type-checks without a non-null assertion.
		return { status: "error", dto: plainErrorDTO("runPreviewSave: not a file") }
	}

	const name = asNewFile ?? driveItemName(base)
	const mime = args.mime ?? base.data.decryptedMeta?.mime ?? ""
	const options: UploadTimes = times === undefined ? {} : { ...times, noExifOverride: true }
	// Root-sentinel collapse inlined: the one-line uuid compare is all normalizeParentUuid (queries/drive.ts) does.
	const targetParent = base.data.parent === deps.rootUuid ? null : base.data.parent

	// Encoded once: the pre-flight and the upload both need the bytes.
	const body = typeof content === "string" ? new TextEncoder().encode(content) : content
	const needed = neededBytes(body, base.data)

	if (needed !== null) {
		const verdict = await (deps.checkQuota ?? checkUploadQuota)(needed)

		if (verdict.status === "exceeds") {
			// The writer on the port's other end would otherwise block on a reader that never comes.
			if (!(body instanceof Uint8Array) && "port" in body) {
				body.port.close()
			}

			// Tagged as the server's refusal so callers treat both alike; the buffer stays dirty for a retry.
			return { status: "error", dto: plainErrorDTO(quotaExceededMessage(verdict), "MaxStorageReached") }
		}
	}

	let uploaded: SdkFile
	try {
		uploaded = await runOp(upload(deps, base.data, targetParent, body, name, mime, options))
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	const newItem = narrowItem(uploaded)
	const oldUuid = base.data.uuid

	deps.patchListing(
		targetParent,
		prev => (asNewFile === undefined ? dropUuid(upsertDriveItem(prev, newItem), oldUuid) : upsertDriveItem(prev, newItem)),
		{ writeNow: true }
	)

	return { status: "success", item: newItem }
}

// What a save adds to the account: the bytes, the Blob, or for an Orientation rewrite the file itself (only its head
// changes). Null when not known up front (a port without a stated size): the server decides then.
function neededBytes(content: Exclude<PreviewSaveContent, string>, file: SdkFile): bigint | null {
	if (content instanceof Uint8Array) {
		return BigInt(content.byteLength)
	}

	if ("blob" in content) {
		return BigInt(content.blob.size)
	}

	if ("orientation" in content) {
		return file.size
	}

	return content.size === undefined ? null : BigInt(content.size)
}

function upload(
	deps: PreviewSaveDeps,
	file: SdkFile,
	parent: string | null,
	content: Exclude<PreviewSaveContent, string>,
	name: string,
	mime: string,
	options: UploadTimes
): Promise<SdkFile> {
	if (content instanceof Uint8Array) {
		return deps.uploadFileBytes(parent, Comlink.transfer(content, [content.buffer]), name, mime, options)
	}

	if ("blob" in content) {
		return deps.uploadFileBlob === undefined
			? Promise.reject(new Error("runPreviewSave: no blob upload"))
			: deps.uploadFileBlob(parent, content.blob, name, mime, options)
	}

	if ("orientation" in content) {
		return deps.rewriteOrientation === undefined
			? Promise.reject(new Error("runPreviewSave: no orientation rewrite"))
			: deps.rewriteOrientation(file, content.orientation, parent, name, mime, options)
	}

	if (deps.uploadFileFromPort === undefined) {
		content.port.close()

		return Promise.reject(new Error("runPreviewSave: no port upload"))
	}

	return deps.uploadFileFromPort(parent, Comlink.transfer(content.port, [content.port]), name, mime, {
		...options,
		...(content.size === undefined ? {} : { size: content.size })
	})
}

// An edited image as the remote-change dialog's "save mine as new" writes it. `extension`: the format it was written in
// when that is not the original's (a copy-only format), so the new file is named for it; null keeps the name's.
export interface ImageSaveEdits {
	readonly kind: "blob"
	readonly blob: Blob
	readonly extension: string | null
}

// The times an edited image is saved with, as a new version or a copy: created stays the original's (its own, else
// the capture time the Photos timeline sorts it by), modified is now.
export function imageSaveTimes(item: DriveItem, now: number): { created: bigint; modified: bigint } {
	const modified = BigInt(Math.floor(now))

	if (item.type !== "file") {
		const base = asDirectoryOrFile(item)

		return { created: base.type === "file" ? (base.data.decryptedMeta?.created ?? base.data.timestamp) : modified, modified }
	}

	return { created: item.data.decryptedMeta?.created ?? BigInt(Math.floor(captureTimestamp(item))), modified }
}

// A presentation save as the overlay drives it (the editor's presentationRef makes one per save): the session writes
// to one end of a channel while the SDK worker uploads from the other. `result` is the session's answer (it waits for
// the upload to say whether it made the file); once the upload made `file`, commit() moves the session onto it,
// answering whether edits made meanwhile leave it dirty. A written save must be committed: the session holds its
// reads of the old file (which a drive without versioning deletes) until then.
export interface PresentationSaveEdits {
	readonly kind: "port"
	// The upload's end of the channel: handed to the upload only once `announced` is true.
	readonly port: MessagePort
	// The session is going to write (true), or ended first with nothing to upload (false: unchanged, refused), so no
	// upload is opened at all.
	readonly announced: Promise<boolean>
	readonly result: Promise<SaveResult>
	commit(file: DriveItem): Promise<{ readonly dirty: boolean }>
}

// What the user is told when the session refuses a save: the presentation's own reasons, else the editors' common one.
export function presentationSaveRefusalKey(reason: Extract<SaveResult, { kind: "refused" }>["reason"]): PreviewKey {
	switch (reason) {
		case "proofFailed":
			return "previewPptxSaveRefusedCheck"
		case "notImplemented":
		case "unsupported":
			return "previewPptxSaveRefusedUnsupported"
		case "stale":
			return "previewPptxSaveRefusedStale"
		default:
			return "previewSaveFailed"
	}
}

export type PresentationSaveSource = (options: { auto: boolean }) => Promise<PresentationSaveEdits | null>

// The session calls a save needs (the editor's PresentationClient).
export interface PresentationSaveSession {
	save(options: { readonly reason: "user" | "auto"; readonly port: PortLike }): Promise<SaveResult>
	commitSaved(options: {
		readonly file: DriveFileRef
		readonly port: PortLike
		readonly size: number
		readonly revision: number
	}): Promise<{ readonly dirty: boolean }>
}

// Starts one save of `session` (what an editor's presentationRef returns). `openRangePort` serves the saved file's
// ranges on a port (sdkApi.openRangePort), which the session reads from once it is committed.
export function presentationSaveEdits(
	session: PresentationSaveSession,
	openRangePort: (port: MessagePort, file: DriveItem) => void,
	auto: boolean
): PresentationSaveEdits {
	const channel = new MessageChannel()
	// Listening before the session can say anything.
	const announced = savePortAnnounced(channel.port2)
	const result = session.save({ reason: auto ? "auto" : "user", port: channel.port1 })

	return {
		kind: "port",
		port: channel.port2,
		announced,
		result,
		async commit(file) {
			const answer = await result

			if (answer.kind !== "written") {
				throw new Error(`commit of a save that was not written (${answer.kind})`)
			}

			const range = new MessageChannel()
			const saved = asDirectoryOrFile(file)

			openRangePort(range.port2, file)

			return session.commitSaved({
				file: { uuid: saved.data.uuid, name: driveItemName(saved) },
				port: range.port1,
				size: Number(saved.data.size),
				revision: answer.revision
			})
		}
	}
}

// True for the one save-failure class where retrying is pointless — resolveNormalDirParent's own
// thrown message (sdk.worker.ts, PARENT_NOT_FOUND_PREFIX) when the file's own parent directory no
// longer exists (deleted from another session mid-edit, etc.). Every other failure (network blip,
// quota, a transient SDK error) is worth letting the user retry — previewOverlay.tsx's performSave
// reserves its read-only lockdown for this class alone.
export function isUnresolvableParentError(dto: ErrorDTO): boolean {
	return dto.species === "plain" && dto.message.startsWith(PARENT_NOT_FOUND_PREFIX)
}
