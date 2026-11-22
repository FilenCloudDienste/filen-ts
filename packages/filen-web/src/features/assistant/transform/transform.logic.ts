import { presentableDiff } from "@codemirror/merge"
import { isTransformLanguage, TRANSFORM_LANGUAGES, type TransformLanguage } from "@filen/shared/assistant"
import type { AssistantModelState } from "@/features/assistant/types"

export const TRANSFORM_LANGUAGE_CODES = Object.keys(TRANSFORM_LANGUAGES) as TransformLanguage[]

// How many recently used translation targets the Translate submenu lists before "All languages…".
export const RECENT_LANGUAGES = 3

// The UI language as a translation target ("pt-BR" is Portuguese), English when it is none of them.
export function uiTransformLanguage(language: string): TransformLanguage {
	const primary = language.split(/[-_]/u)[0]?.toLowerCase() ?? ""

	return isTransformLanguage(primary) ? primary : "en"
}

// The Translate submenu's first entries: the recently used targets, newest first, or the UI language before any.
export function recentTransformLanguages(recent: readonly TransformLanguage[], ui: TransformLanguage): TransformLanguage[] {
	const known = recent.filter(isTransformLanguage)

	return known.length > 0 ? known.slice(0, RECENT_LANGUAGES) : [ui]
}

export function withRecentLanguage(recent: readonly TransformLanguage[], picked: TransformLanguage): TransformLanguage[] {
	return [picked, ...recent.filter(language => language !== picked)].slice(0, RECENT_LANGUAGES)
}

// Whether the device can run the model at all: not when the startup check found the browser unsupported or the memory
// too small. Another tab holding it is not that (it is explained on use).
export function assistantRunsHere(state: AssistantModelState): boolean {
	return !(state.kind === "unavailable" && state.reason !== "in-use-elsewhere")
}

// Whether a transform can be offered at all: the model runs, or can be downloaded or loaded, here. Not before the
// startup check answers, nor where the device can never run it.
export function transformOffered(state: AssistantModelState): boolean {
	return state.kind !== "checking" && assistantRunsHere(state)
}

export interface DiffSegment {
	kind: "same" | "removed" | "added"
	text: string
}

// The result against the selection, as runs a reader can follow (whole words where a change covers part of one).
export function diffSegments(before: string, after: string): DiffSegment[] {
	const segments: DiffSegment[] = []
	const push = (kind: DiffSegment["kind"], text: string) => {
		if (text.length === 0) {
			return
		}

		const last = segments.at(-1)

		if (last?.kind === kind) {
			last.text += text
		} else {
			segments.push({ kind, text })
		}
	}
	let at = 0

	for (const change of presentableDiff(before, after)) {
		push("same", before.slice(at, change.fromA))
		push("removed", before.slice(change.fromA, change.toA))
		push("added", after.slice(change.fromB, change.toB))
		at = change.toA
	}

	push("same", before.slice(at))

	return segments
}
