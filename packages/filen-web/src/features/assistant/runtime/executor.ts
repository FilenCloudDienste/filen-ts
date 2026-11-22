import type {
	AssistantHistoryTurn,
	AssistantSignal,
	AssistantTool,
	AssistantToolExecutor,
	AssistantToolOutcome,
	AssistantToolProgress
} from "@filen/shared/assistant"
import type { UserCalendar } from "@/features/assistant/tools/dates"
import type { AssistantBatchPlan } from "@/features/assistant/types"

// The web app's side of the agent loop (@filen/shared/assistant's loop): the loop owns routing, the
// guard and the model; the executor owns everything that touches the app. The implementation is
// createAssistantToolExecutor (features/assistant/tools/executor.ts): one instance per conversation,
// since the handles it hands out ("f3", "d1", "n2", "c4", "p1", "t5") live as long as the conversation
// does. UUIDs never reach the model.
//
// Per call the loop runs check() before the guard (a "/path" where a handle belongs comes back as the
// item's handle, a name as candidate handles), asks the user to confirm a consequential call (preview()
// fills the card), then execute() with `confirmed`. draft_chat_message is consequential: it writes the
// composer draft and opens the chat, and never sends.

export interface AssistantHandleRef {
	handle: string
	name: string
}

// Every string is already sanitized against the known template patterns; the loop sanitizes again with the
// model's own special tokens.
export type AssistantToolExecution = AssistantToolOutcome

// An item a call acts on; a chat with the addresses of the people a draft to it reaches.
export interface AssistantPreviewTarget extends AssistantHandleRef {
	recipients?: string[]
	// A restored file's or directory's destination path.
	where?: string
}

// The arguments naming where a move, copy, create or playlist addition lands, or the directory a batch works in. The
// card shows it apart from the items: a directory by its path, a playlist by its name.
export const DESTINATION_ARGS = ["destination", "parent", "playlist", "scope"] as const

// A confirmation card's content for a call check() passed.
export type AssistantToolPreview =
	| {
			ok: true
			title: string
			// The items the call acts on, resolved to their names.
			targets: AssistantPreviewTarget[]
			// Free-text arguments (new names, message text), verbatim.
			text: Record<string, string>
			// A batch call's plan, which is what runs.
			batch?: AssistantBatchPlan
	  }
	| {
			ok: false
			error: string
	  }

// What one turn's context leaves out: `withoutDocument` when the user detached the open document from the question
// (the chip above the composer), so neither the context line nor get_context names it.
export interface AssistantTurnContextOptions {
	withoutDocument?: boolean
}

export interface ToolExecutor extends AssistantToolExecutor {
	context(options?: AssistantTurnContextOptions): ReturnType<AssistantToolExecutor["context"]>
	// `calendar`: the turn's, which its prompt's date line was written by; the current one when absent.
	execute(
		call: {
			callId: string
			tool: AssistantTool
			args: Record<string, unknown>
			confirmed: boolean
			signal: AssistantSignal
			onProgress?: (progress: AssistantToolProgress) => void
			calendar?: UserCalendar
		} & AssistantTurnContextOptions
	): Promise<AssistantToolExecution>
	preview(call: { tool: AssistantTool; args: Record<string, unknown> }): Promise<AssistantToolPreview>
	// A new conversation: forgets every handle. `history` is a resumed conversation's exchanges, whose replies
	// may name handles from an earlier page; those are never handed out again.
	reset(history?: readonly AssistantHistoryTurn[]): void
}
