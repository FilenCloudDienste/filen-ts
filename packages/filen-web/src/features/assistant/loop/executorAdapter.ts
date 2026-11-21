import {
	isConsequentialTool,
	sanitizeUntrustedText,
	type AssistantSignal,
	type AssistantTool,
	type AssistantToolExecutor
} from "@filen/shared/assistant"
import {
	DESTINATION_ARGS,
	type AssistantToolExecution,
	type AssistantToolPreview,
	type ToolExecutor
} from "@/features/assistant/runtime/executor"
import { NOTE_FLAG_ARGS, type AssistantProposal, type AssistantProposalAction } from "@/features/assistant/types"
import type { UserCalendar } from "@/features/assistant/tools/dates"
import { AssistantToolError, unlessStopped } from "@/features/assistant/tools/format"

// The confirmation card a consequential tool gets. A consequential tool without one cannot run at all.
export function proposalAction({ tool, args }: { tool: string; args: Record<string, unknown> }): AssistantProposalAction | null {
	switch (tool) {
		case "draft_chat_message":
			return "draft-message"
		case "move_items":
			return "move"
		case "copy_items":
			return "copy"
		case "trash_items":
			return "trash"
		case "restore_items":
			return "restore"
		case "rename_item":
			return "rename"
		case "rename_by_pattern":
			return "batch-rename"
		case "organize_by_date":
			return "organize-by-date"
		case "set_favorite":
			return args["favorite"] === true ? "favorite" : "unfavorite"
		case "create_directory":
			return "create-directory"
		case "create_note":
			return "create-note"
		case "set_note_flags":
			return "note-flags"
		case "add_tracks_to_playlist":
			return "add-to-playlist"
		default:
			return null
	}
}

// The flags a set_note_flags call changes, as the card lists them: the checked call carries only the changes.
function noteFlagText(args: Record<string, unknown>): Record<string, string> {
	return Object.fromEntries(NOTE_FLAG_ARGS.flatMap(flag => (typeof args[flag] === "boolean" ? [[flag, String(args[flag])]] : [])))
}

// A name on the card: other people choose items', chats' and contacts' names, so it is shown without the
// invisible and direction-changing characters that would make one read as another, and on one line.
function cardName(name: string): string {
	return sanitizeUntrustedText(name).replace(/\s+/g, " ").trim()
}

export function buildProposal({
	id,
	tool,
	args,
	preview
}: {
	id: string
	tool: AssistantTool
	args: Record<string, unknown>
	preview: Extract<AssistantToolPreview, { ok: true }>
}): AssistantProposal | null {
	const action = proposalAction({ tool: tool.name, args })

	if (action === null) {
		return null
	}

	const destinationHandles = new Set(DESTINATION_ARGS.map(key => args[key]).filter(value => typeof value === "string"))
	const destination = preview.targets.find(target => destinationHandles.has(target.handle))

	return {
		id,
		action,
		targets: preview.targets
			.filter(target => !destinationHandles.has(target.handle))
			.map(({ handle, name, recipients }) => ({
				handle,
				name: cardName(name),
				...(recipients === undefined ? {} : { recipients: recipients.map(cardName) })
			})),
		destination: destination === undefined ? null : cardName(destination.name),
		text: action === "note-flags" ? noteFlagText(args) : preview.text
	}
}

export interface TurnExecutor {
	shared: AssistantToolExecutor
	// Runs a confirmed call now, inside the confirming click; the loop's execute() then awaits this run.
	start(call: { callId: string; tool: AssistantTool; args: Record<string, unknown> }): Promise<AssistantToolExecution>
}

// The tools the loop may offer: those the executor runs, a consequential one only with a card the UI can show.
export function supportedTools(executor: ToolExecutor): (tool: AssistantTool) => boolean {
	return tool =>
		(executor.supports?.(tool) ?? true) && (!isConsequentialTool(tool) || proposalAction({ tool: tool.name, args: {} }) !== null)
}

// The app's ToolExecutor for one turn: every check and call gets the turn's signal, a confirmed call can be started
// before the loop resumes, and a consequential tool the UI has no card for is refused at the check. A confirmed
// call gets `actionSignal` instead, which outlives the turn: it runs to its end and settles its card truthfully.
export function turnExecutor({
	executor,
	signal,
	actionSignal,
	calendar
}: {
	executor: ToolExecutor
	signal: AssistantSignal
	actionSignal: AssistantSignal
	calendar: UserCalendar
}): TurnExecutor {
	const started = new Map<string, Promise<AssistantToolExecution>>()

	const run = (
		call: { callId: string; tool: AssistantTool; args: Record<string, unknown>; confirmed: boolean },
		callSignal: AssistantSignal = signal
	) => executor.execute({ ...call, signal: callSignal, calendar })

	return {
		shared: {
			context: () => executor.context(),

			name: handle => executor.name?.(handle),

			supports: supportedTools(executor),

			// Raced against the turn like execute: resolving a path reads listings, which wait while offline, and
			// a check that never settles would keep the turn's hold on the model after Stop.
			check: async call => {
				let checked: Awaited<ReturnType<ToolExecutor["check"]>>

				try {
					checked = await unlessStopped(executor.check(call), signal)
				} catch (e) {
					if (e instanceof AssistantToolError) {
						return { ok: false, invalid: false, error: e.message, result: { error: e.message } }
					}

					throw e
				}

				if (checked.ok && isConsequentialTool(call.tool) && proposalAction({ tool: call.tool.name, args: checked.args }) === null) {
					const error = `"${call.tool.title}" is not available yet; the user can do it in the app`

					return { ok: false, invalid: false, error, result: { error } }
				}

				return checked
			},

			execute: async call => {
				const running = started.get(call.callId)

				started.delete(call.callId)

				return running ?? run(call)
			}
		},

		start: call => {
			const running = run({ ...call, confirmed: true }, actionSignal)

			started.set(call.callId, running)

			return running
		}
	}
}
