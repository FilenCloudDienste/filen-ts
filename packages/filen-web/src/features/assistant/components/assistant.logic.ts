import { formatBytesFixed } from "@filen/shared"
import type { AssistantDocumentCoverage, AssistantDocumentKind } from "@filen/shared/assistant"
import type { AssistantKey } from "@/lib/i18n"
import type { TranscriptEntry, TranscriptStep, TurnActions } from "@/features/assistant/store/transcript"
import {
	NOTE_FLAG_ARGS,
	type AssistantBatchPlan,
	type AssistantModelState,
	type AssistantStepExtract,
	type AssistantStepFailure,
	type AssistantStepRoute,
	type AssistantTurnError,
	type NoteFlagArg
} from "@/features/assistant/types"

// A document read that covered only part of what it asked for, under the reply it led to; `subject` is the
// document's name.
export interface CoverageNote {
	id: string
	subject: string | null
	coverage: AssistantDocumentCoverage
}

export type TranscriptRow =
	| TranscriptEntry
	| { kind: "thinking"; id: "thinking" }
	| {
			kind: "footer"
			id: string
			turnId: string
			coverage: readonly CoverageNote[]
			// The act-on-read row, and the reply it acts on as shown.
			actions: TurnActions | null
			reply: string
	  }

type DocumentUnitWord = "page" | "slide" | "sheet" | "part"

const UNIT_WORDS: Readonly<Record<AssistantDocumentKind, DocumentUnitWord>> = {
	pdf: "page",
	docx: "page",
	slides: "slide",
	sheet: "sheet",
	text: "part"
}

type ExtractKey = Extract<AssistantKey, `assistantStepReading${string}`>
type CoveredKey = Extract<AssistantKey, `assistantCovered${string}`>
type ReadRestKey = Extract<AssistantKey, `assistantReadRest${string}`>

const EXTRACT_KEYS: Readonly<Record<DocumentUnitWord, { one: ExtractKey; many: ExtractKey }>> = {
	page: { one: "assistantStepReadingPage", many: "assistantStepReadingPages" },
	slide: { one: "assistantStepReadingSlide", many: "assistantStepReadingSlides" },
	sheet: { one: "assistantStepReadingSheet", many: "assistantStepReadingSheets" },
	part: { one: "assistantStepReadingPart", many: "assistantStepReadingPart" }
}

// "Reading pages 9–14 (2 of 6)"; a text in parts, "Reading part 2 of 6".
export function extractStepKey({ kind, from, to }: AssistantStepExtract): ExtractKey {
	const keys = EXTRACT_KEYS[UNIT_WORDS[kind]]

	return from === to ? keys.one : keys.many
}

const COVERED_KEYS: Readonly<
	Record<DocumentUnitWord, { range: CoveredKey; part: CoveredKey; rest: Exclude<ReadRestKey, "assistantReadRest"> }>
> = {
	page: { range: "assistantCoveredPages", part: "assistantCoveredPartOfPage", rest: "assistantReadRestPages" },
	slide: { range: "assistantCoveredSlides", part: "assistantCoveredPartOfSlide", rest: "assistantReadRestSlides" },
	sheet: { range: "assistantCoveredSheets", part: "assistantCoveredPartOfSheet", rest: "assistantReadRestSheets" },
	part: { range: "assistantCoveredPages", part: "assistantCoveredPartOfPage", rest: "assistantReadRestPages" }
}

// "Covered pages 1–23 of 41.", and the message [Read the rest] sends: from the first unit not covered.
export function coverageKeys(coverage: AssistantDocumentCoverage): {
	note: CoveredKey
	rest: Exclude<ReadRestKey, "assistantReadRest">
	restFrom: number
} {
	const keys = COVERED_KEYS[UNIT_WORDS[coverage.kind]]

	return {
		note: coverage.to < coverage.from ? keys.part : keys.range,
		rest: keys.rest,
		restFrom: Math.max(coverage.from, coverage.to + 1)
	}
}

// The partial reads of a completed turn, for the note under its last reply.
function coverageNotes(entry: StepsEntry): CoverageNote[] {
	return entry.steps.flatMap(step =>
		step.kind === "tool" && step.coverage !== undefined ? [{ id: step.id, subject: step.subject, coverage: step.coverage }] : []
	)
}

// Each completed turn whose reads covered only part of a document, or whose reply can be acted on, gets a footer row
// right after its last reply.
function withFooters(entries: readonly TranscriptEntry[], actions: Readonly<Record<string, TurnActions>>): readonly TranscriptRow[] {
	const footers = new Map<string, CoverageNote[]>()
	const lastReply = new Map<string, number>()

	for (const [index, entry] of entries.entries()) {
		if (entry.kind === "reply") {
			lastReply.set(entry.turnId, index)
		} else if (entry.kind === "steps" && entry.outcome === "complete") {
			const notes = coverageNotes(entry)

			if (notes.length > 0) {
				footers.set(entry.turnId, notes)
			}
		}
	}

	if (footers.size === 0 && Object.keys(actions).length === 0) {
		return entries
	}

	const rows: TranscriptRow[] = []

	for (const [index, entry] of entries.entries()) {
		rows.push(entry)

		const notes = footers.get(entry.turnId)
		const offered = actions[entry.turnId] ?? null

		if ((notes !== undefined || offered !== null) && entry.kind === "reply" && entry.final && lastReply.get(entry.turnId) === index) {
			rows.push({
				kind: "footer",
				id: `footer:${entry.turnId}`,
				turnId: entry.turnId,
				coverage: notes ?? [],
				actions: offered,
				reply: entry.text
			})
		}
	}

	return rows
}

type DownloadingState = Extract<AssistantModelState, { kind: "downloading" }>

export function downloadPercent(receivedBytes: number, sizeBytes: number): number {
	if (sizeBytes <= 0) {
		return 0
	}

	return Math.min(100, Math.max(0, Math.floor((receivedBytes / sizeBytes) * 100)))
}

// Both figures in one format, the received part capped at the total: two precisions (one decimal against
// two) read as "2.6 GiB of 2.55 GiB" in the last few megabytes.
export function downloadByteFigures(receivedBytes: number, sizeBytes: number): { received: string; total: string } {
	return {
		received: formatBytesFixed(Math.min(sizeBytes, Math.max(0, receivedBytes))),
		total: formatBytesFixed(sizeBytes)
	}
}

// A download the runtime continued by itself has just started: said once, not on every progress update.
export function resumedDownloadStarted(previous: AssistantModelState, next: AssistantModelState): next is DownloadingState {
	return next.kind === "downloading" && next.resumed && previous.kind !== "downloading"
}

// The download the runtime continued by itself is over, or a click restarted it.
export function resumedDownloadEnded(previous: AssistantModelState, next: AssistantModelState): boolean {
	return previous.kind === "downloading" && previous.resumed && !(next.kind === "downloading" && next.resumed)
}

// The whole percentage of a running download, null otherwise.
export function downloadingPercent(state: AssistantModelState): number | null {
	return state.kind === "downloading" ? downloadPercent(state.receivedBytes, state.model.sizeBytes) : null
}

// A sent message waiting for the model reads as loading from the start: the runtime reports "loading" only
// after it has let an unload in flight finish, asked the GPU and taken the lock.
export function modelShowsLoading(state: AssistantModelState, turnActive: boolean): boolean {
	return state.kind === "loading" || (state.kind === "downloaded" && turnActive)
}

// Files on disk: what "Remove downloaded model" can delete. A failed load still left them there, and a
// stopped, failed or full download leaves the part it fetched (kept so it can resume), and an update leaves
// the earlier model version until the new one downloads.
export function canRemoveModel(state: AssistantModelState): boolean {
	switch (state.kind) {
		case "downloaded":
		case "ready":
			return true
		case "error":
			return state.error === "load-failed" || state.error === "out-of-memory" || (state.partialBytes ?? 0) > 0
		case "not-downloaded":
			return (state.partialBytes ?? 0) > 0 || (state.staleBytes ?? 0) > 0
		default:
			return false
	}
}

// What Remove frees, for the states canRemoveModel accepts: the part a download left plus an earlier
// version's files, else the whole model. A downloaded model may also take earlier versions with it, which
// the state does not carry.
export function removableModelBytes(state: AssistantModelState): number {
	switch (state.kind) {
		case "not-downloaded":
			return (state.partialBytes ?? 0) + (state.staleBytes ?? 0)
		case "error":
			return state.error === "load-failed" || state.error === "out-of-memory"
				? (state.model?.sizeBytes ?? 0)
				: (state.partialBytes ?? 0)
		default:
			return state.model?.sizeBytes ?? 0
	}
}

// The waiting bubble shows only until the turn's step list or reply appears: the list says what is
// happening from then on.
export function transcriptRows(
	entries: readonly TranscriptEntry[],
	activeTurnId: string | null,
	actions: Readonly<Record<string, TurnActions>> = {}
): readonly TranscriptRow[] {
	const rows = withFooters(entries, actions)

	if (activeTurnId === null) {
		return rows
	}

	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]

		if (entry?.turnId !== activeTurnId) {
			break
		}

		if (entry.kind === "steps" || entry.kind === "reply") {
			return rows
		}
	}

	return [...rows, { kind: "thinking", id: "thinking" }]
}

type StepsEntry = Extract<TranscriptEntry, { kind: "steps" }>

// A step shows its time from here on: quicker ones would only add noise.
export const SLOW_STEP_MS = 1000

// A call the user declined, or a repeat that was not run again, did not go wrong: no warning for it.
const NO_FAULT = new Set<AssistantStepFailure>(["declined", "repeated"])

export function stepFaulted(step: TranscriptStep): boolean {
	return step.status === "failed" && !(step.kind === "tool" && step.failure !== null && NO_FAULT.has(step.failure))
}

// What a turn is busy with, to announce: a card waiting on the user first, else its newest row running.
// Queued calls have not started; thinking between steps reads as the generic "responding" instead of a row
// of its own each time.
export function currentStep(entry: StepsEntry): TranscriptStep | null {
	return (
		entry.steps.find(step => step.status === "waiting") ??
		entry.steps.findLast(step => step.status === "active" && step.kind !== "thinking") ??
		null
	)
}

export function stepDurationMs(step: TranscriptStep): number | null {
	return step.endedAt === null ? null : Math.max(0, step.endedAt - step.startedAt)
}

export function stepsSummary(entry: StepsEntry): { tools: number; durationMs: number; failed: boolean } {
	let tools = 0
	let failed = false

	for (const step of entry.steps) {
		// A repeat ran nothing.
		if (step.kind === "tool" && step.failure !== "repeated") {
			tools++
		}

		failed ||= stepFaulted(step)
	}

	return { tools, durationMs: Math.max(0, entry.lastAt - entry.startedAt), failed }
}

// Seconds, with one decimal below ten; a running step counts whole seconds.
export function durationFigure(ms: number, live: boolean): { seconds: number; fractionDigits: 0 | 1 } {
	const seconds = Math.max(0, ms) / 1000

	return live || seconds >= 10 ? { seconds: Math.floor(seconds), fractionDigits: 0 } : { seconds, fractionDigits: 1 }
}

// The prompt-reading bar shows only while some of the prompt is left; at 1 the model is writing.
export function visibleProgress(progress: number | null): number | null {
	return progress === null || progress >= 1 ? null : Math.max(0, progress)
}

export const ROUTE_KEYS: Record<AssistantStepRoute, AssistantKey> = {
	files: "assistantStepRoutedFiles",
	insights: "assistantStepRoutedInsights",
	shared: "assistantStepRoutedShared",
	organize: "assistantStepRoutedOrganize",
	batch: "assistantStepRoutedBatch",
	trash: "assistantStepRoutedTrash",
	restore: "assistantStepRoutedRestore",
	notes: "assistantStepRoutedNotes",
	chats: "assistantStepRoutedChats",
	audio: "assistantStepRoutedAudio",
	navigation: "assistantStepRoutedNavigation",
	help: "assistantStepRoutedHelp",
	answer: "assistantStepRoutedAnswer"
}

export const STEP_FAILURE_KEYS: Record<AssistantStepFailure, AssistantKey> = {
	invalid: "assistantStepFailedInvalid",
	error: "assistantStepFailedError",
	blocked: "assistantStepFailedBlocked",
	declined: "assistantStepFailedDeclined",
	repeated: "assistantStepFailedRepeated"
}

// A call's label with what it acts on, for the tools that act on one thing. Looked up through a Map, like
// the activity keys below.
const TOOL_SUBJECT_KEYS = {
	search_items: "assistantStepSearchItems",
	list_directory: "assistantStepListDirectory",
	get_item_info: "assistantStepGetItemInfo",
	get_sharing: "assistantStepGetSharing",
	read_text_file: "assistantStepReadTextFile",
	read_document: "assistantStepReadDocument",
	reveal_item: "assistantStepRevealItem",
	set_favorite: "assistantStepSetFavorite",
	create_directory: "assistantStepCreateDirectory",
	rename_item: "assistantStepRenameItem",
	move_items: "assistantStepMoveItems",
	copy_items: "assistantStepCopyItems",
	rename_by_pattern: "assistantStepRenameByPattern",
	organize_by_date: "assistantStepOrganizeByDate",
	trash_items: "assistantStepTrashItems",
	restore_items: "assistantStepRestoreItems",
	list_notes: "assistantStepListNotes",
	read_note: "assistantStepReadNote",
	search_note_text: "assistantStepSearchNoteText",
	open_note: "assistantStepOpenNote",
	create_note: "assistantStepCreateNote",
	set_note_flags: "assistantStepSetNoteFlags",
	list_chats: "assistantStepListChats",
	read_chat: "assistantStepReadChat",
	open_chat: "assistantStepOpenChat",
	draft_chat_message: "assistantStepDraftChatMessage",
	find_contacts: "assistantStepFindContacts",
	open_playlist: "assistantStepOpenPlaylist",
	play: "assistantStepPlay",
	add_tracks_to_playlist: "assistantStepAddTracksToPlaylist"
} as const satisfies Record<string, AssistantKey>

export type ToolSubjectKey = (typeof TOOL_SUBJECT_KEYS)[keyof typeof TOOL_SUBJECT_KEYS]

const SUBJECT_KEYS = new Map<string, ToolSubjectKey>(Object.entries(TOOL_SUBJECT_KEYS))

export function toolSubjectKey(tool: string): ToolSubjectKey | null {
	return SUBJECT_KEYS.get(tool) ?? null
}

// What a listing's count is of.
export type StepCountNoun = "items" | "notes" | "chats" | "playlists"

const COUNT_NOUNS = new Map<string, StepCountNoun>([
	["list_notes", "notes"],
	["list_chats", "chats"],
	["list_playlists", "playlists"]
])

export function stepCountNoun(tool: string): StepCountNoun {
	return COUNT_NOUNS.get(tool) ?? "items"
}

export const TURN_END_KEYS: Record<"cancelled" | AssistantTurnError, AssistantKey> = {
	cancelled: "assistantTurnCancelled",
	"model-unavailable": "assistantTurnErrorModelUnavailable",
	"context-full": "assistantTurnErrorContextFull",
	"message-too-long": "assistantTurnErrorMessageTooLong",
	"no-reply": "assistantTurnErrorNoReply",
	expired: "assistantTurnErrorExpired",
	failed: "assistantTurnErrorFailed"
}

// Keyed by the registry names in @filen/shared/assistant (tools.ts). A Map, so a name the model or a
// newer runtime makes up never resolves through the object prototype.
const TOOL_ACTIVITY_KEYS = new Map<string, AssistantKey>([
	["get_context", "assistantToolGetContext"],
	["search_items", "assistantToolSearchItems"],
	["list_directory", "assistantToolListDirectory"],
	["get_item_info", "assistantToolGetItemInfo"],
	["recent_items", "assistantToolRecentItems"],
	["list_photos", "assistantToolListPhotos"],
	["get_storage", "assistantToolGetStorage"],
	["list_section", "assistantToolListSection"],
	["get_sharing", "assistantToolGetSharing"],
	["read_text_file", "assistantToolReadTextFile"],
	["read_document", "assistantToolReadDocument"],
	["reveal_item", "assistantToolRevealItem"],
	["set_favorite", "assistantToolSetFavorite"],
	["create_directory", "assistantToolCreateDirectory"],
	["rename_item", "assistantToolRenameItem"],
	["move_items", "assistantToolMoveItems"],
	["copy_items", "assistantToolCopyItems"],
	["rename_by_pattern", "assistantToolRenameByPattern"],
	["organize_by_date", "assistantToolOrganizeByDate"],
	["trash_items", "assistantToolTrashItems"],
	["restore_items", "assistantToolRestoreItems"],
	["list_notes", "assistantToolListNotes"],
	["read_note", "assistantToolReadNote"],
	["search_note_text", "assistantToolSearchNoteText"],
	["open_note", "assistantToolOpenNote"],
	["create_note", "assistantToolCreateNote"],
	["set_note_flags", "assistantToolSetNoteFlags"],
	["list_chats", "assistantToolListChats"],
	["read_chat", "assistantToolReadChat"],
	["open_chat", "assistantToolOpenChat"],
	["draft_chat_message", "assistantToolDraftChatMessage"],
	["find_contacts", "assistantToolFindContacts"],
	["list_playlists", "assistantToolListPlaylists"],
	["open_playlist", "assistantToolOpenPlaylist"],
	["play", "assistantToolPlay"],
	["audio_control", "assistantToolAudioControl"],
	["add_tracks_to_playlist", "assistantToolAddTracksToPlaylist"],
	["get_transfers", "assistantToolGetTransfers"],
	["app_help", "assistantToolAppHelp"],
	["get_desktop_status", "assistantToolGetDesktopStatus"],
	["open_route", "assistantToolOpenRoute"]
])

export function toolActivityKey(tool: string): AssistantKey {
	return TOOL_ACTIVITY_KEYS.get(tool) ?? "assistantToolGeneric"
}

// The words a note-flags card states each change in: [when set, when cleared].
const NOTE_FLAG_CHANGE_KEYS: Readonly<Record<NoteFlagArg, readonly [AssistantKey, AssistantKey]>> = {
	pinned: ["assistantProposalPin", "assistantProposalUnpin"],
	favorite: ["assistantProposalNoteFavorite", "assistantProposalNoteUnfavorite"],
	archived: ["assistantProposalArchive", "assistantProposalUnarchive"]
}

// A note-flags card's changes, in the order the call applies them (executorAdapter.ts stores each as "true" or
// "false").
export function noteFlagChangeKeys(text: Readonly<Record<string, string>>): AssistantKey[] {
	return NOTE_FLAG_ARGS.flatMap(flag => {
		const value = text[flag]
		const [set, cleared] = NOTE_FLAG_CHANGE_KEYS[flag]

		return value === "true" ? [set] : value === "false" ? [cleared] : []
	})
}

export type ProposalTargetKind = "file" | "directory" | "note" | "chat" | "playlist" | "track"

const TARGET_KINDS = new Map<string, ProposalTargetKind>([
	["f", "file"],
	["d", "directory"],
	["n", "note"],
	["c", "chat"],
	["p", "playlist"],
	["t", "track"]
])

// The handle's leading letter is its kind (runtime/executor.ts); only the icon depends on it, so an
// unexpected handle still renders, as a file.
export function proposalTargetKind(handle: string): ProposalTargetKind {
	return TARGET_KINDS.get(handle.charAt(0)) ?? "file"
}

// Markdown punctuation a screen reader would otherwise spell out.
export function spokenText(markdown: string): string {
	return markdown.replace(/[*`]/g, "").replace(/^[#>]+\s*/gm, "")
}

// How many files a batch card changes: what its title and its confirm button count.
export function batchChangeCount(plan: AssistantBatchPlan): number {
	return plan.changes?.length ?? plan.groups?.reduce((sum, group) => sum + group.items.length, 0) ?? 0
}
