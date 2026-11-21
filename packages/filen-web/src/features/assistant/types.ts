// The one contract between the assistant's UI (components/, store/) and whatever drives the model (runtime/,
// tools/). The UI never imports the runtime: an implementation hands itself to registerAssistantSession
// (store/assistantSession.ts), and every state change reaches the UI as an AssistantEvent.
//
// Names, paths and free text in here are shown verbatim, as plain text. A step carries the tool's name and
// at most a short sanitized subject; the UI owns its wording (locales/en/assistant.ts).

import type { AssistantRoute, TransformKind, TransformLanguage } from "@filen/shared/assistant"

export interface AssistantModelInfo {
	// Stable build id (cache directory, logs). Never shown.
	id: string
	// Shown on the setup screen, e.g. "Qwen3.5 4B".
	name: string
	// The whole download, every shard, in bytes.
	sizeBytes: number
}

// Why the model cannot run here. Terminal for this device, except "in-use-elsewhere": another tab holds the
// model (one tab loads it), and the runtime re-emits the real state once that tab lets go.
export type AssistantUnavailableReason = "unsupported-browser" | "insufficient-memory" | "in-use-elsewhere"

export type AssistantModelError = "download-failed" | "load-failed" | "out-of-memory" | "storage-full"

// "downloaded": the files are on disk but not in memory. They load only on request (a sent message or
// loadModel), passing through "loading", and leave memory again after a while without activity, panel open
// or not; `idleUnloaded` says that is why they are not loaded. `model` on unavailable/error is what would
// have been (or was being) installed, when known.
// "downloading": `receivedBytes` is exact and never above `model.sizeBytes`; at the size, only the last
// bookkeeping is left. `waiting`: nothing is moving, the device is offline or the download is backing off
// after network errors, and it continues on its own. `resumed`: no click started it; it continues one the
// user started that a reload, crash or closed tab cut off.
// "loading": `verifying` while shards are hashed before the start, which happens only when the record of
// verified shards was lost or a start failed and the files are checked for damage.
// `partialBytes` on not-downloaded and error: part of the model is on disk (a stopped or failed download,
// kept so it can resume), which the user can still remove. `staleBytes` on not-downloaded: an earlier model
// version's files, which this build never loads and the user can still remove.
// "checking": before the startup check (device, other tabs, what is on disk) has answered; nothing to offer yet.
export type AssistantModelState =
	| { kind: "checking"; model: AssistantModelInfo | null }
	| { kind: "unavailable"; reason: AssistantUnavailableReason; model: AssistantModelInfo | null }
	| { kind: "not-downloaded"; model: AssistantModelInfo; partialBytes?: number; staleBytes?: number }
	| { kind: "downloading"; model: AssistantModelInfo; receivedBytes: number; waiting: boolean; resumed: boolean }
	| { kind: "downloaded"; model: AssistantModelInfo; idleUnloaded: boolean }
	| { kind: "loading"; model: AssistantModelInfo; verifying: boolean }
	| { kind: "ready"; model: AssistantModelInfo }
	| { kind: "error"; error: AssistantModelError; model: AssistantModelInfo | null; partialBytes?: number }

// The tool group the turn was routed to ("answer": no tools).
export type AssistantStepRoute = AssistantRoute

// "queued": a call written and waiting for the calls before it. "waiting": on the user (a confirmation
// card). "stopped": the turn ended while it ran. "discarded": the model abandoned a call it had started to
// write; the row goes away.
export type AssistantStepStatus = "active" | "queued" | "waiting" | "done" | "failed" | "stopped" | "discarded"

// Why a call did not complete: malformed, the app refused or failed it, the guard blocked it, the user
// declined it, or it repeated a call that already ran (so it was not run again). The last two are no fault.
export type AssistantStepFailure = "invalid" | "error" | "blocked" | "declined" | "repeated"

// One row of a turn's progress list, re-emitted with the same id as it changes; the UI upserts by id.
// `progress` is the share (0..1) of a prompt the model has read so far, while it is reading one, or of a
// running call's own work when the call reports it.
// "thinking" and "replying" rows exist only while active: what they lead to (a call, the reply) shows next.
export type AssistantStep =
	| { id: string; kind: "loading" | "thinking" | "replying"; status: AssistantStepStatus; progress: number | null }
	| { id: string; kind: "routing"; status: AssistantStepStatus; progress: number | null; route: AssistantStepRoute | null }
	| {
			id: string
			kind: "tool"
			status: AssistantStepStatus
			progress: number | null
			// The registry name ("search_items"); the UI words it, with a generic line for a name it does not know.
			tool: string
			// What the call acts on (an item's name, a search query), sanitized and shortened; null until the
			// arguments are checked, or when the call names several items.
			subject: string | null
			// How many items a listing or search returned; `resultMore` when the list was cut off.
			resultCount: number | null
			resultMore: boolean
			failure: AssistantStepFailure | null
			// While a long call runs (a search waiting for the drive's index): how many it has found so far.
			found?: number
	  }

// A row its turn ended under: "stopped" when the user stopped the turn, "failed" (with an error) when the
// turn failed.
export function endedStep<T extends AssistantStep>(step: T, status: "stopped" | "failed"): T {
	return step.kind === "tool" && status === "failed"
		? { ...step, status, progress: null, failure: "error" }
		: { ...step, status, progress: null }
}

export type AssistantProposalAction =
	| "draft-message"
	| "move"
	| "copy"
	| "trash"
	| "restore"
	| "rename"
	| "batch-rename"
	| "organize-by-date"
	| "favorite"
	| "unfavorite"
	| "create-directory"
	| "create-note"
	| "note-flags"
	| "add-to-playlist"

// The flags a note-flags card changes, in the order the card lists them and the call applies them.
export const NOTE_FLAG_ARGS = ["pinned", "favorite", "archived"] as const

export type NoteFlagArg = (typeof NOTE_FLAG_ARGS)[number]

// An item the call acts on, as the tool preview resolved it. The handle's leading letter picks the icon
// (f file, d directory, n note, c chat, p playlist, t track); the handle itself is never shown.
export interface AssistantProposalTarget {
	handle: string
	name: string
	// A chat's: the addresses of the people a draft to it reaches. Its name is whatever a contact or a group's
	// owner chose, so it alone cannot tell two chats apart.
	recipients?: readonly string[]
}

// A consequential call waiting for the user. Nothing happens until its card is confirmed. `targets` are
// every item it acts on (the card lists each name and counts them); `destination` is the target
// directory's path for move/copy, or the playlist's name for add-to-playlist; `text` holds the free-text
// arguments verbatim, keyed by argument name ("text" is a draft's message, "name" a new name), and a note-flags
// card's changes as "pinned" / "favorite" / "archived" set to "true" or "false".
export interface AssistantProposal {
	id: string
	action: AssistantProposalAction
	targets: readonly AssistantProposalTarget[]
	destination: string | null
	text: Readonly<Record<string, string>>
}

// "message-too-long": the message alone does not fit the model. "no-reply": the turn ended without any
// reply text to show. "expired": a confirmation card went unanswered until the turn gave up on it.
export type AssistantTurnError = "model-unavailable" | "context-full" | "message-too-long" | "no-reply" | "expired" | "failed"

// One finished exchange of the conversation, as the model sees it in the next turns.
export interface AssistantExchange {
	user: string
	reply: string
}

export type AssistantEvent =
	| { type: "model"; state: AssistantModelState }
	// The FULL screened text of one reply bubble so far, not a delta: the runtime re-screens the whole reply
	// on every emission (a link the user never typed must not flash up mid-stream). A turn can hold several
	// replies (text written before tool calls is a reply of its own); `final` marks a reply that will not
	// change again. `withheld`: the reply repeated the assistant's instructions; its text is empty and the UI
	// shows its own message in its place. A final reply with no text and not withheld removes its bubble.
	| { type: "reply"; turnId: string; replyId: string; text: string; final: boolean; withheld?: boolean }
	// `at`: when it happened (Date.now()), for durations.
	| { type: "step"; turnId: string; step: AssistantStep; at: number }
	| { type: "proposal"; turnId: string; proposal: AssistantProposal }
	// A confirmed proposal finished. Rejected and expired proposals are settled by the UI itself.
	| { type: "proposal-settled"; proposalId: string; outcome: "done" | "failed" }
	// `at`: when the turn ended (Date.now()), which closes its duration.
	| { type: "turn-end"; turnId: string; at: number; outcome: "complete" | "cancelled" }
	| { type: "turn-end"; turnId: string; at: number; outcome: "error"; error: AssistantTurnError }

export interface AssistantSession {
	// Current snapshot; changes are announced through a "model" event.
	getModelState: () => AssistantModelState
	// Returns its own unsubscribe. Events are delivered synchronously, in order.
	subscribe: (listener: (event: AssistantEvent) => void) => () => void
	// Whether the panel (or its narrow-screen drawer) is on screen. Called on every change, and once right
	// after registration. Never loads the model.
	setPanelOpen: (open: boolean) => void
	// Starts (or, from "error", retries) the opt-in download, or the load that failed. Called from a user click.
	downloadModel: () => void
	// Called once the signed-in app shows: continues a download the user started that a reload, crash or
	// closed tab cut off, when the runtime finds one. Never starts a download that was not asked for.
	resumeInterruptedDownload: () => void
	// Loads a downloaded model ahead of the first message. Called from a user click.
	loadModel: () => void
	// The user is typing: postpones the unload that follows inactivity. Cheap enough for every keystroke.
	noteActivity: () => void
	cancelDownload: () => void
	// Frees the disk space; settles with the model back in "not-downloaded".
	deleteModel: () => Promise<void>
	// Starts a turn and returns its id; a model not in memory is loaded first, within the turn. Only called
	// while the model is downloaded, loading or ready, and no turn is running.
	send: (message: string) => string
	// Stops the running turn; it still ends with a "turn-end" event (outcome "cancelled").
	cancel: () => void
	// Runs the proposal. Called inside the trusted click handler of the Confirm button, so it MUST start the
	// work synchronously: a download started after an await has lost the user activation.
	confirm: (proposalId: string) => void
	// The user declined, or the card expired because a new message was sent first.
	reject: (proposalId: string) => void
	// Forgets the conversation (the running turn, pending cards, the tools' handles) so the next turn starts
	// from an empty context, or from `history` when an earlier conversation is resumed.
	reset: (history?: readonly AssistantExchange[]) => void
	// The exchanges the next turn will see, oldest first.
	getHistory: () => readonly AssistantExchange[]
	// Signing out: stops the running turn, declines every waiting card, frees the model and refuses anything
	// further; nothing may touch the account's data during the wipe.
	shutdown: () => void
}

// A selection transform (rewrite, shorten, fix grammar, translate): one generation over text the user selected in
// an editor, outside the conversation (no router, no tools, no history). `onText` gets the whole output so far;
// `onProgress` the share (0..1) of the prompt read, before the first word. The model loads first when it is on disk
// but not in memory. One runs at a time: a new one stops the one before.
export interface AssistantTransformRequest {
	kind: TransformKind
	text: string
	// The target of a translation; the other kinds ignore it.
	language: TransformLanguage
	signal: AbortSignal
	onText: (text: string) => void
	onProgress?: (share: number) => void
}

// "too-long": the selection does not fit the kind. "model-unavailable": the model could not be loaded (the model
// state says why). "cancelled": the request's signal, a newer request or signing out stopped it.
export type AssistantTransformError = "too-long" | "model-unavailable" | "cancelled" | "failed"

// `text` is the model's output as Accept applies it, never rewritten for display; `foreignLinks` are the links and
// addresses in it the selection did not hold. `truncated`: it stopped at its length limit.
export type AssistantTransformOutcome =
	{ ok: true; text: string; truncated: boolean; foreignLinks: readonly string[] } | { ok: false; error: AssistantTransformError }

export interface AssistantTransformer {
	run: (request: AssistantTransformRequest) => Promise<AssistantTransformOutcome>
	// Signing out: stops the one running and refuses anything further.
	shutdown: () => void
}
