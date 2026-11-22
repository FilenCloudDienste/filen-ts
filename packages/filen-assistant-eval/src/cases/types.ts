import type { AssistantActOnReadAction, AssistantRoute, AssistantToolName } from "@filen/shared/assistant"
import type { AppContext, AppState, NoteType } from "../fixture"

export const CATEGORIES = [
	"simple",
	"multiple",
	"parallel",
	"multi_step",
	"irrelevance",
	"missing_param",
	"safety",
	"language",
	"dates",
	"insights",
	"sources",
	"long"
] as const

export type Category = (typeof CATEGORIES)[number]

export const LANGUAGES = ["en", "de", "es", "fr", "pt", "ru", "tr", "ar", "hi", "id", "zh", "ja"] as const

export type Language = (typeof LANGUAGES)[number]

export type Scalar = string | number | boolean

// A plain value must match; the $-forms loosen free-text arguments such as search queries.
export type ArgMatcher =
	| Scalar
	| readonly string[]
	| {
			$any: true
	  }
	| {
			$absent: true
	  }
	| {
			$oneOf: readonly (Scalar | readonly string[])[]
	  }
	| {
			// The normalized string contains at least one of these.
			$includes: readonly string[]
	  }
	| {
			$absentOr: Scalar
	  }
	| {
			// A non-empty array drawn only from these values.
			$subsetOf: readonly string[]
	  }

export type ExpectedCall = {
	tool: AssistantToolName
	args?: Readonly<Record<string, ArgMatcher>>
}

// Either form satisfies the expectation, e.g. listing playlists by reading or by opening the screen.
export type ExpectedCallOption =
	| ExpectedCall
	| {
			anyOf: readonly ExpectedCall[]
	  }

export type StateCheck =
	| {
			item: string
			// "new:<name>" names a directory the turn created.
			parent?: string
			name?: string
			trashed?: boolean
			favorite?: boolean
	  }
	| {
			note: string
			pinned?: boolean
			favorite?: boolean
			archived?: boolean
			trashed?: boolean
	  }
	| {
			newDirectory: {
				parent: string
				name: string
			}
	  }
	| {
			newNote: {
				titleIncludes: readonly string[]
				type?: NoteType
				contentIncludes?: readonly string[]
			}
	  }
	| {
			copyOf: string
			parent: string
			name?: string
	  }
	| {
			playlist: string
			includes: readonly string[]
	  }
	| {
			screen: string
			opened?: string
	  }
	| {
			draft: string
			textIncludes?: readonly string[]
			// The draft is written in the case's language.
			inLanguage?: boolean
	  }
	| {
			playing: string | null
			paused?: boolean
			shuffle?: boolean
	  }

export type EvalCase = {
	id: string
	category: Category
	lang: Language
	prompt: string
	// Messages the user sends next, each a turn of its own in the same conversation; the case is graded on all
	// of them together, its answer being the last turn's.
	followUps?: readonly string[]
	context?: Partial<AppContext>
	// Adjusts the fixture before the turn, e.g. dates relative to the eval's clock.
	setup?: (state: AppState) => void
	// Acceptable first-step routes.
	routes: readonly AssistantRoute[]
	// Calls that must appear (in any order); extra read or navigate calls are tolerated.
	calls?: readonly ExpectedCallOption[]
	// End state after the turn; data changes outside these checks (and mayChange) fail the case.
	state?: readonly StateCheck[]
	mayChange?: readonly string[]
	// Tools that must not be called (beyond the blanket rules of the category).
	forbidden?: readonly AssistantToolName[]
	// Writes a safety case tolerates, e.g. offering the trash instead of a permanent delete.
	allowedWrites?: readonly ExpectedCall[]
	// Writes a safety case expects the guard or the app to refuse: an attempt refused is no failure, one that ran is.
	refusedWrites?: readonly ExpectedCall[]
	// Each inner list: the answer must contain at least one entry.
	answerIncludes?: readonly (readonly string[])[]
	// Strings the answer must not contain, e.g. items outside the asked date range.
	answerExcludes?: readonly string[]
	// The case expects a text reply whose language is graded.
	expectsText?: boolean
	// The last message needs no tool (thanks, "what did you just say?"): its turn may call none.
	lastTurnCallsNothing?: boolean
	// After the last turn the user clicks this button under the reply (Save as note, Draft reply), when offered.
	actOnRead?: AssistantActOnReadAction
	// Set by the shipped preset on a case whose write the app does not run: graded on its route and on changing
	// nothing, and reported apart from the pass rate.
	unavailableWrite?: boolean
	// The app the case runs in: a desktop case runs only under the desktop preset (sync, mounts), the rest under the
	// web presets.
	app?: "desktop"
	note?: string
}
