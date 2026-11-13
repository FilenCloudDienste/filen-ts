import { useSyncExternalStore } from "react"
import { toast } from "sonner"
import type { PresentationRefusal } from "@filen/office/core/presentation"
import type {
	ConversionLossKind,
	ConversionReport,
	OpenInfo,
	PresentationClient,
	PresentationEvent,
	PresentationOpenOptions,
	PresentationSessionApi,
	PresentationWorkerPool,
	SourceSpec
} from "@filen/office/dom/presentation"
import { savePortReader } from "@filen/shared/savePort"
import { uploadConvertedCopy } from "@/features/drive/lib/convertedCopy"
import type { DriveItem } from "@/features/drive/lib/item"
import type { LegacySaveCopy } from "@/features/presentation/components/legacyView"
import { i18n, type PreviewKey } from "@/lib/i18n"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { log } from "@/lib/log"

// A presentation converted from a session (the open editor's, or one opened for the conversion alone): the fresh
// package the worker streams through a save port, kept as the chunks it came in (a download takes them as a Blob, never
// joined), and what the copy holds differently, by kind.

export type PresentationTarget = "pptx" | "odp"

export interface FreshPackage {
	readonly chunks: readonly Uint8Array[]
	readonly size: number
	readonly report: ConversionReport
}

// The worker writes the package to the port and answers with its report. A refusal ends the read (a worker that refuses
// may never write); the refusal is what is thrown. `signal` cancels the read, which fails the worker's next write.
export async function readFreshPackage(
	session: PresentationSessionApi,
	target: PresentationTarget,
	signal?: AbortSignal
): Promise<FreshPackage> {
	const channel = new MessageChannel()
	const reader = savePortReader(channel.port2)
	const answer = session.freshParts(target, channel.port1)
	const onAbort = (): void => {
		reader.abort("cancelled")
	}

	answer.catch(() => {
		reader.abort("failed")
	})
	signal?.addEventListener("abort", onAbort, { once: true })

	const chunks: Uint8Array[] = []
	let size = 0

	try {
		for (let chunk = await reader.read(); chunk !== undefined; chunk = await reader.read()) {
			chunks.push(chunk)
			size += chunk.length
		}
	} catch (error) {
		// The worker's own failure says more than the port's abort.
		await answer
		throw error
	} finally {
		signal?.removeEventListener("abort", onAbort)
	}

	const report = await answer

	reader.settled(true)

	return { chunks, size, report }
}

export function joinFreshPackage(fresh: FreshPackage): Uint8Array {
	const bytes = new Uint8Array(fresh.size)
	let at = 0

	for (const chunk of fresh.chunks) {
		bytes.set(chunk, at)
		at += chunk.length
	}

	return bytes
}

// What a copy holds differently, by loss kind (plural keys but where a deck has one of it); a kind the engine adds
// fails the typecheck here until it has its words.
const LOSS_KEYS = {
	oleObject: "previewPptxLossOleObject",
	media: "previewPptxLossMedia",
	animation: "previewPptxLossAnimation",
	transition: "previewPptxLossTransition",
	comment: "previewPptxLossComment",
	macros: "previewPptxConvertLossMacros",
	action: "previewPptxLossAction",
	wordArt: "previewPptxLossWordArt",
	customGeometry: "previewPptxLossCustomGeometry",
	picture: "previewPptxLossPicture",
	slideColorScheme: "previewPptxLossSlideColorScheme",
	patternFill: "previewPptxLossPatternFill",
	damagedContent: "previewPptxLossDamaged",
	fill: "previewPptxConvertLossFill",
	line: "previewPptxConvertLossLine",
	geometry: "previewPptxConvertLossGeometry",
	outlineLevel: "previewPptxConvertLossOutlineLevel",
	text: "previewPptxConvertLossText",
	numbering: "previewPptxConvertLossNumbering",
	tableStyle: "previewPptxConvertLossTableStyle",
	chart: "previewPptxConvertLossChart",
	chartDetail: "previewPptxConvertLossChartDetail",
	field: "previewPptxConvertLossField",
	smartArt: "previewPptxConvertLossSmartArt",
	threeD: "previewPptxConvertLossThreeD",
	ink: "previewPptxConvertLossInk",
	shape: "previewPptxConvertLossShape",
	background: "previewPptxConvertLossBackground",
	slideSize: "previewPptxConvertLossSlideSize",
	showSettings: "previewPptxConvertLossShowSettings",
	signature: "previewPptxConvertLossSignature",
	writeReservation: "previewPptxConvertLossWriteReservation",
	mediaTiming: "previewPptxConvertLossMediaTiming",
	bookmarkTrigger: "previewPptxConvertLossBookmarkTrigger",
	commentReply: "previewPptxConvertLossCommentReply",
	commentState: "previewPptxConvertLossCommentState",
	section: "previewPptxConvertLossSection",
	embeddedFont: "previewPptxConvertLossEmbeddedFont",
	properties: "previewPptxConvertLossProperties"
} as const satisfies Readonly<Record<ConversionLossKind, string>>

export type ConversionLossKey = (typeof LOSS_KEYS)[ConversionLossKind]

function isLossKind(kind: string): kind is ConversionLossKind {
	return Object.hasOwn(LOSS_KEYS, kind)
}

// The report's losses as the lines a list or a warning shows, in the report's order.
export function conversionLossLines(report: ConversionReport, translate: (key: ConversionLossKey, count: number) => string): string[] {
	return report.losses.flatMap(loss => (isLossKind(loss.kind) ? [translate(LOSS_KEYS[loss.kind], loss.count)] : []))
}

// A copy saved beside its deck, whose differences the deck's surface shows in a dialog until it is closed (the menu
// that saved it is gone by then). `session` names the deck it was saved from.
export interface SavedPresentationCopy {
	readonly session: PresentationSessionApi
	readonly item: DriveItem
	readonly name: string
	readonly differently: readonly string[]
	readonly protected: boolean
	readonly open: ((item: DriveItem) => void) | undefined
}

let shownCopy: SavedPresentationCopy | null = null
const copyListeners = new Set<() => void>()

export function showSavedCopy(copy: SavedPresentationCopy | null): void {
	shownCopy = copy

	for (const listener of copyListeners) listener()
}

function subscribeCopy(listener: () => void): () => void {
	copyListeners.add(listener)

	return () => {
		copyListeners.delete(listener)
	}
}

function currentCopy(): SavedPresentationCopy | null {
	return shownCopy
}

// The copy saved from `session`'s deck, while its dialog shows.
export function useSavedCopy(session: PresentationSessionApi | undefined): SavedPresentationCopy | null {
	const copy = useSyncExternalStore(subscribeCopy, currentCopy, currentCopy)

	return copy !== null && copy.session === session ? copy : null
}

const FAILED_KEYS: Readonly<Record<PresentationTarget, PreviewKey>> = {
	pptx: "previewPptxSaveAsPptxFailed",
	odp: "previewPptxConvertSaveAsOdpFailed"
}

// Writes the copy, uploads it beside the deck and tells what became of it: a toast on failure; a copy that holds
// something differently (or, `always`, any copy) in the dialog, else opened at once. Resolves once told; never rejects.
export async function saveConvertedCopy(
	copy: LegacySaveCopy,
	target: PresentationTarget,
	options: { readonly always?: boolean; readonly failedKey?: PreviewKey } = {}
): Promise<void> {
	const failedKey = options.failedKey ?? FAILED_KEYS[target]
	const written = await readFreshPackage(copy.session, target).catch((e: unknown) => {
		log.error("presentation", `Save as .${target} failed`, e)

		return null
	})

	if (written === null) {
		toast.error(i18n.t(`preview:${failedKey}`))

		return
	}

	const outcome = await uploadConvertedCopy(copy.item, joinFreshPackage(written), target).catch((e: unknown) => {
		log.error("presentation", `uploading the .${target} copy failed`, e)

		return { status: "error", dto: null } as const
	})

	if (outcome.status === "error") {
		toast.error(outcome.dto === null ? i18n.t(`preview:${failedKey}`) : errorLabel(outcome.dto))

		return
	}

	const differently = conversionLossLines(written.report, (key, count) => i18n.t(`preview:${key}`, { count }))

	if (differently.length === 0 && options.always !== true) {
		toast.success(i18n.t("preview:previewPptxSavedAsPptx", { name: outcome.name }))
		copy.onOpenFile?.(outcome.item)

		return
	}

	showSavedCopy({
		session: copy.session,
		item: outcome.item,
		name: outcome.name,
		differently,
		protected: copy.encrypted && target === "pptx",
		open: copy.onOpenFile
	})
}

// A deck opened for a conversion alone (no window rendered, view-only): what its open answered.
export type ConvertOpenAnswer =
	| { readonly kind: "opened"; readonly info: OpenInfo }
	| { readonly kind: "password"; readonly wrong: boolean }
	| { readonly kind: "refused"; readonly reason: PresentationRefusal }

export interface ConvertSession {
	readonly client: PresentationClient
	// The open's first answer.
	readonly opened: Promise<ConvertOpenAnswer>
	// The answer to a password.
	unlock(password: string): Promise<ConvertOpenAnswer>
	close(): void
}

export function openConvertSession(
	pool: PresentationWorkerPool,
	source: SourceSpec,
	options: Pick<PresentationOpenOptions, "format" | "fileName">
): ConvertSession {
	let waiting: ((answer: ConvertOpenAnswer) => void) | null = null
	const next = (): Promise<ConvertOpenAnswer> =>
		new Promise(resolve => {
			waiting = resolve
		})
	const answer = (value: ConvertOpenAnswer): void => {
		const resolve = waiting

		waiting = null
		resolve?.(value)
	}
	const listener = (event: PresentationEvent): void => {
		if (event.type === "opened") answer({ kind: "opened", info: event.info })
		else if (event.type === "error")
			answer(
				event.reason === "needsPassword" || event.reason === "wrongPassword"
					? { kind: "password", wrong: event.reason === "wrongPassword" }
					: { kind: "refused", reason: event.reason }
			)
	}
	const opened = next()
	const client = pool.open(source, { ...options, viewOnly: true }, listener)

	return {
		client,
		opened,
		unlock: password => {
			const answered = next()

			client.unlock(password)

			return answered
		},
		close: () => {
			answer({ kind: "refused", reason: "closed" })
			client.close()
		}
	}
}
