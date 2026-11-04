// What document spelling needs from a spellchecker. The app supplies it (web: the @filen/spellcheck host
// plus the user's synced dictionary; mobile: native bindings later), so the office core never loads an
// engine or a dictionary itself.

export interface SpellingSuggestOptions {
	// Also the slow pass (n-gram): for "more suggestions" or when the fast pass found nothing.
	readonly more?: boolean
}

export interface SpellingChecker {
	// The dictionary that checks text in a language (an OOXML w:lang tag), or undefined when none does.
	dictionaryFor(language: string): string | undefined
	// The cached verdict for a word: true correct, false misspelled, undefined not checked yet.
	known(dictionary: string, word: string): boolean | undefined
	// Checks words that have no verdict yet; known() answers for them once it resolves.
	check(dictionary: string, words: Iterable<string>): Promise<void>
	suggest(dictionary: string, word: string, options?: SpellingSuggestOptions): Promise<readonly string[]>
	// Adds a word to the user's dictionary (every language, every document).
	addToDictionary(word: string): Promise<void>
	// Hears when verdicts may have changed (the user's dictionary changed): text is checked again.
	subscribe(listener: () => void): () => void
	// A document starts being checked; the returned call ends that (its spelling is disposed). A checker may
	// let go of its engine and caches once no document is open.
	open?(): () => void
}

export type SpellingKind = "spelling" | "repeated"

// A range to mark: a word not in its language's dictionary, or a word repeated right after itself.
export interface SpellingMark {
	readonly from: number
	readonly to: number
	readonly kind: SpellingKind
}

export interface SpellingIssue extends SpellingMark {
	// The word as checked (soft hyphens removed).
	readonly word: string
	// The language tag that chose the dictionary.
	readonly language: string
	readonly dictionary: string
}
