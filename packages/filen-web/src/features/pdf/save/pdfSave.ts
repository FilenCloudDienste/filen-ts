import { savePortAnnounced } from "@filen/shared/savePort"
import type { PdfMemoryProfile } from "@filen/office/core/pdfedit"
import type { RedactionFailure, RedactionManifest } from "@filen/office/core/pdfedit/redactVerify"
import {
	createSyncRangeBuffer,
	type PdfAfterSave,
	type PdfSaveBegun,
	type PdfSaveCheck,
	type PdfSaveEnded,
	type PdfSaveExpectation,
	type PdfSaveProtection
} from "@filen/office/dom/pdfedit"
import type { PdfEditSessionModel } from "@filen/office/react/pdfedit"
import type { SaveResult } from "@filen/office/dom/presentation"
import { BLOCK_BYTES } from "@filen/shared/videos"
import type { DriveItem } from "@/features/drive/lib/item"
import { editedSaveTimes, SaveRefusedError, type PresentationSaveEdits } from "@/features/drive/lib/previewSave.logic"
import type { PdfEngine } from "@/features/pdf/session/engineWorker"
import type { PdfSignedSaveJob } from "@/features/pdf/signing/signDocument"
import type { ActionOutcome } from "@/lib/actions/outcome"
import type { PreviewKey } from "@/lib/i18n"
import { log } from "@/lib/log"

// A PDF save from the page's side. The engine writes the document into its heap (planned first: incremental only for
// a signed document whose signers allowed every change, else a full rewrite; refused over the memory budget), a second
// short-lived engine checks the written file by reading it from that heap (pages, revisions, encryption), and only then
// do its bytes stream to the upload, over a save port with their exact size. The engine holds the written file until
// the save ends: as a new version (the session goes on, its history kept; or on the written file opened in place where
// the old version will not stay readable; or in a fresh engine when the heap grew past its threshold), as a copy, or
// not at all (nothing changes). An interrupted upload never counts as saved.

// A written file opened in place on the engine's heap only up to this size; a larger one is read again from the drive.
export const PDF_ADOPT_MAX_BYTES = 64 * 1024 * 1024

export interface PdfSaveDeps {
	readonly engine: PdfEngine
	readonly session: PdfEditSessionModel
	readonly memory: PdfMemoryProfile
	// The password the document was opened with (the verifying engine opens the written file with it).
	readonly password: string | undefined
	// Opens a verifying engine on a channel (engineWorker openPdfEngineOnChannel).
	readonly openVerifier: (
		channel: { buffer: SharedArrayBuffer; port: MessagePort; length: number },
		password: string | undefined
	) => Promise<PdfEngine>
	// The account keeps earlier versions (an old version stays readable after a save); undefined when not known.
	readonly versioning: () => boolean | undefined
	// After a new version: the heap is past its threshold, so the session moves to a fresh engine on `saved`.
	readonly needsRespawn: (heapBytes: number) => boolean
	readonly respawn: (saved: DriveItem) => Promise<void>
	// The history started again (the user is told).
	readonly onHistoryReset: () => void
	// Asked before a save that invalidates `count` signatures; false cancels it. Without it such a save is refused.
	readonly confirmInvalidation?: (count: number) => Promise<boolean>
	// A new version was written with new protection: the password that opens it now (its owner password), undefined
	// when it has none.
	readonly onProtected?: (password: string | undefined) => void
	// A new version was written whose changes since the last save removed content (deleted pages, redacted, cropped-away
	// or replaced content), and the account keeps earlier versions (they still hold it): the user is offered deleting
	// them.
	readonly onEarlierVersions?: (saved: DriveItem) => void
}

// A redacted file that failed the redaction check: nothing was uploaded. `failure` says what remained.
export class PdfRedactionRefusedError extends SaveRefusedError {
	readonly failure: RedactionFailure

	constructor(failure: RedactionFailure) {
		super("previewPdfSaveVerifyFailed", { silent: true })
		this.name = "PdfRedactionRefusedError"
		this.failure = failure
	}
}

// The password a written file opens with: its new owner password, none once its protection was removed, else the
// document's own.
function openingPassword(protection: PdfSaveProtection, password: string | undefined): string | undefined {
	return protection.kind === "new" ? protection.ownerPassword : protection.kind === "none" ? undefined : password
}

function refusalKey(reason: Extract<PdfSaveBegun, { status: "refused" }>["reason"]): PreviewKey {
	switch (reason) {
		case "overBudget":
			return "previewPdfOverBudget"
		case "poisoned":
			return "previewPdfPoisoned"
		case "invalidatesSignatures":
			return "previewPdfToolSigned"
	}
}

// Writes the document into the engine's heap and has a second engine check it. Throws SaveRefusedError (the save
// ended, nothing was uploaded) when it was refused or failed the check.
async function writeAndCheck(deps: PdfSaveDeps, inputBytes: number): Promise<Extract<PdfSaveBegun, { status: "written" }>> {
	const { client } = deps.engine
	const state = deps.session.getSnapshot().state
	const begin = (invalidateConfirmed: boolean) => client.call("saveBegin", { inputBytes, memory: deps.memory, invalidateConfirmed })
	let begun = await begin(false)

	// A rewrite that breaks signatures happens only once the user agreed.
	if (begun.status === "refused" && begun.reason === "invalidatesSignatures" && deps.confirmInvalidation !== undefined) {
		if (!(await deps.confirmInvalidation(begun.plan.invalidates.length)))
			throw new SaveRefusedError("previewPdfSaveFailed", { silent: true })

		begun = await begin(true)
	}

	if (begun.status === "refused") throw new SaveRefusedError(refusalKey(begun.reason))

	const redaction = begun.redaction

	await checkWritten(
		deps,
		begun.size,
		{ pageCount: state.pageCount, versions: begun.versions, encryption: begun.encryption, protection: begun.protection },
		openingPassword(begun.protection, deps.password),
		redaction === null ? undefined : verifier => redactionCheck(verifier, redaction)
	)

	return begun
}

// What the steps redacted, checked in the verifying engine (after checkSaved: it changes the document in memory).
async function redactionCheck(verifier: PdfEngine, manifest: RedactionManifest): Promise<HeldOutputCheck> {
	const verdict = await verifier.client.call("verifyRedaction", { manifest })

	return verdict.ok ? { ok: true } : { ok: false, redaction: verdict.failure }
}

// The written file checked (checkHeldOutput, with `more` on top); a file that fails is dropped, the save ended, and
// nothing is uploaded.
async function checkWritten(
	deps: PdfSaveDeps,
	size: number,
	expected: PdfSaveExpectation,
	password: string | undefined,
	more?: (verifier: PdfEngine) => Promise<HeldOutputCheck>
): Promise<void> {
	const check = await checkHeldOutput(deps.engine.client, deps.openVerifier, password, size, expected, more)

	if (!check.ok) {
		log.warn(
			"pdf",
			"the written file failed its check",
			"redaction" in check ? { redaction: check.redaction } : { reason: check.reason }
		)
		await end(deps, "failed", "continue")

		throw "redaction" in check ? new PdfRedactionRefusedError(check.redaction) : new SaveRefusedError("previewPdfSaveVerifyFailed")
	}
}

// What a check of a held file found: a failed redaction check says what remained.
export type HeldOutputCheck = PdfSaveCheck | { readonly ok: false; readonly redaction: RedactionFailure }

// The file an engine holds (a save's output, a new file of pages) checked by a second, short-lived engine reading it
// from the first one's heap, opened with `password`: pages, revisions and encryption, then `more` (what a redaction
// removed, a new signature).
export async function checkHeldOutput(
	client: Pick<PdfEngine["client"], "call">,
	openVerifier: PdfSaveDeps["openVerifier"],
	password: string | undefined,
	size: number,
	expected: PdfSaveExpectation,
	more?: (verifier: PdfEngine) => Promise<HeldOutputCheck>
): Promise<HeldOutputCheck> {
	const buffer = createSyncRangeBuffer(8, BLOCK_BYTES)
	const channel = new MessageChannel()

	return client
		.call("serveOutput", { buffer, port: channel.port1 }, [channel.port1])
		.then(() => openVerifier({ buffer, port: channel.port2, length: size }, password))
		.then(async (verifier): Promise<HeldOutputCheck> => {
			try {
				const saved = await verifier.client.call("checkSaved", expected)

				return !saved.ok || more === undefined ? saved : await more(verifier)
			} finally {
				void verifier.close()
			}
		})
		.catch((error: unknown) => ({ ok: false as const, reason: error instanceof Error ? error.message : String(error) }))
}

async function end(deps: PdfSaveDeps, outcome: "saved" | "copied" | "failed", next: PdfAfterSave): Promise<PdfSaveEnded> {
	const ended = await deps.engine.client.call("saveEnd", { outcome, next })

	deps.session.saved(ended)

	return ended
}

// Streams the held file to an upload over a new channel; resolves whether the upload made the file. `port` is the
// upload's end.
function stream(deps: PdfSaveDeps): HeldOutputStream {
	return streamHeldOutput(deps.engine.client)
}

export interface HeldOutputStream {
	readonly port: MessagePort
	readonly announced: Promise<boolean>
	readonly uploaded: Promise<boolean>
}

// The file an engine holds streamed to an upload over a new channel; `port` is the upload's end.
export function streamHeldOutput(client: Pick<PdfEngine["client"], "call">): HeldOutputStream {
	const channel = new MessageChannel()
	const announced = savePortAnnounced(channel.port2)
	const uploaded = client.call("writeOutput", { port: channel.port1 }, [channel.port1]).then(
		written => written.uploaded,
		() => false
	)

	return { port: channel.port2, announced, uploaded }
}

// Save: a new version of `item`, for the preview overlay's port save (PresentationSaveEdits, with the exact size and the
// edited file's times).
export async function savePdfVersion(deps: PdfSaveDeps, item: DriveItem): Promise<PresentationSaveEdits> {
	const begun = await writeAndCheck(deps, Number(item.data.size))
	const upload = stream(deps)
	const result: Promise<SaveResult> = upload.uploaded.then(async uploaded => {
		if (uploaded) return { kind: "written", bytes: begun.size, revision: 0, notices: [] }

		await end(deps, "failed", "continue").catch(() => undefined)

		return { kind: "refused", reason: "failed" }
	})

	return {
		kind: "port",
		port: upload.port,
		announced: upload.announced,
		result,
		size: begun.size,
		times: editedSaveTimes(item, Date.now()),
		commit: async saved => {
			// Without earlier versions the file just replaced may go: the session moves onto the written one.
			const keepsOld = deps.versioning() !== false
			const next: PdfAfterSave = keepsOld || begun.size > PDF_ADOPT_MAX_BYTES ? "continue" : "adopt"
			const ended = await end(deps, "saved", next)

			// The file opens with its new passwords from now on (a respawn reads it with them).
			if (begun.protection.kind !== "keep") deps.onProtected?.(openingPassword(begun.protection, undefined))

			if ((!keepsOld && next === "continue") || deps.needsRespawn(ended.heapBytes)) {
				await deps.respawn(saved)
				deps.onHistoryReset()
			} else if (ended.history === "reset") deps.onHistoryReset()

			// Earlier versions still hold what this one removed.
			if (begun.removesContent && keepsOld) deps.onEarlierVersions?.(saved)

			return { dirty: deps.session.getSnapshot().state.dirty }
		}
	}
}

// Save as copy: the edited document as a new file beside `item` (the document itself stays unsaved). `write` uploads
// the stream as the copy (editedCopy.ts writeEditedCopy).
export async function savePdfCopy(
	deps: PdfSaveDeps,
	item: DriveItem,
	write: (content: {
		readonly port: MessagePort
		readonly size: number
	}) => Promise<{ outcome: ActionOutcome<DriveItem>; name: string } | null>
): Promise<{ outcome: ActionOutcome<DriveItem>; name: string } | null> {
	const begun = await writeAndCheck(deps, Number(item.data.size))
	const upload = stream(deps)
	const [written, uploaded] = await Promise.all([
		upload.announced.then(() => write({ port: upload.port, size: begun.size })),
		upload.uploaded
	])
	const made = uploaded && written?.outcome.status === "success"

	await end(deps, made ? "copied" : "failed", "continue")

	return written
}

// The engine's digests answered by the signer worker, over a channel the signing save holds.
function signerChannel(job: PdfSignedSaveJob): MessagePort {
	const channel = new MessageChannel()

	channel.port2.onmessage = (event: MessageEvent<{ readonly digest: Uint8Array }>) => {
		void job.signer.sign(event.data.digest).then(
			cms => {
				channel.port2.postMessage({ cms }, [cms.buffer])
			},
			(error: unknown) => {
				channel.port2.postMessage({ error: error instanceof Error ? error.message : String(error) })
			}
		)
	}

	return channel.port1
}

// The last segment of a field's name: its own name (/T), as pdf.js reports a signature.
function partialName(field: string): string {
	return field.slice(field.lastIndexOf(".") + 1)
}

// Save, signing the placed signature as its last step (signBegin): the signer worker makes the CMS and is terminated as
// soon as it did; the written file is checked like any save, and the new signature must read "unchanged since signing"
// to our verifier (cross-checked against the signatures already known) before it is uploaded. Kept, the session goes
// on on the signed file, its history starting there (a step back past a signing would bring back its placeholder).
export async function signPdfVersion(deps: PdfSaveDeps, item: DriveItem, job: PdfSignedSaveJob): Promise<PresentationSaveEdits> {
	const port = signerChannel(job)
	const begun = await deps.engine.client
		.call("signBegin", { inputBytes: Number(item.data.size), memory: deps.memory, digest: job.digest, signer: port }, [port])
		.finally(() => {
			job.signer.terminate()
		})

	if (begun.status === "refused") throw new SaveRefusedError("previewPdfOverBudget")

	const known = await job.hints()
	const hints = [...(known ?? []), { name: partialName(begun.field), byteRange: begun.byteRange }]

	const state = deps.session.getSnapshot().state

	await checkWritten(deps, begun.size, { pageCount: state.pageCount, versions: begun.versions, encryption: state.encryption.method }, deps.password, async verifier => {
		const report = await verifier.client.call("verifySignatures", { fields: hints })
		const signature = report.signatures.find(entry => entry.field === begun.field)

		return signature?.state === "unchanged"
			? { ok: true }
			: { ok: false, reason: `the new signature is ${signature?.state ?? "missing"}` }
	})

	const upload = stream(deps)
	const result: Promise<SaveResult> = upload.uploaded.then(async uploaded => {
		if (uploaded) return { kind: "written", bytes: begun.size, revision: 0, notices: [] }

		await end(deps, "failed", "continue").catch(() => undefined)

		return { kind: "refused", reason: "failed" }
	})

	return {
		kind: "port",
		port: upload.port,
		announced: upload.announced,
		result,
		size: begun.size,
		times: editedSaveTimes(item, Date.now()),
		commit: async saved => {
			const ended = await end(deps, "saved", "adopt")

			job.onSigned(begun.field, begun.byteRange)

			if (deps.needsRespawn(ended.heapBytes)) await deps.respawn(saved)

			deps.onHistoryReset()

			return { dirty: deps.session.getSnapshot().state.dirty }
		}
	}
}
