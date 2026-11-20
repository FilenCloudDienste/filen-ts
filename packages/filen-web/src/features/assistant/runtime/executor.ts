import type {
	AssistantHistoryTurn,
	AssistantSignal,
	AssistantTool,
	AssistantToolExecutor,
	AssistantToolOutcome,
	AssistantToolProgress
} from "@filen/shared/assistant"
import type { UserCalendar } from "@/features/assistant/tools/dates"

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
}

// The arguments naming the directory a move, copy or create lands in. The card shows it apart from the items, by
// its path.
export const DESTINATION_ARGS = ["destination", "parent"] as const

// A confirmation card's content for a call check() passed.
export type AssistantToolPreview =
	| {
			ok: true
			title: string
			// The items the call acts on, resolved to their names.
			targets: AssistantPreviewTarget[]
			// Free-text arguments (new names, message text), verbatim.
			text: Record<string, string>
	  }
	| {
			ok: false
			error: string
	  }

export interface ToolExecutor extends AssistantToolExecutor {
	// `calendar`: the turn's, which its prompt's date line was written by; the current one when absent.
	execute(call: {
		callId: string
		tool: AssistantTool
		args: Record<string, unknown>
		confirmed: boolean
		signal: AssistantSignal
		onProgress?: (progress: AssistantToolProgress) => void
		calendar?: UserCalendar
	}): Promise<AssistantToolExecution>
	preview(call: { tool: AssistantTool; args: Record<string, unknown> }): Promise<AssistantToolPreview>
	// A new conversation: forgets every handle. `history` is a resumed conversation's exchanges, whose replies
	// may name handles from an earlier page; those are never handed out again.
	reset(history?: readonly AssistantHistoryTurn[]): void
}
