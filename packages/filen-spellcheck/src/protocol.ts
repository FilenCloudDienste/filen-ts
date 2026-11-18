// Messages between a spellcheck host and its workers. A worker holds the wasm engine and the dictionaries
// it was asked to load; it fetches dictionary files itself (same origin), so no dictionary bytes cross
// threads. Words travel as one "\n"-joined string, verdicts as one byte per word.

// A dictionary file as served: gzip-compressed bytes at `url`; `bytes` and `sha256` describe the file
// after decompression (the manifest's values).
export interface SpellcheckAsset {
	readonly url: string
	readonly bytes: number
	readonly sha256: string
}

export interface SpellcheckDictionaryAssets {
	readonly aff: SpellcheckAsset
	readonly dic: SpellcheckAsset
}

// What a host needs to serve: the engine's wasm module and the dictionaries by id.
export interface SpellcheckAssets {
	readonly wasm: string
	readonly dictionaries: Readonly<Record<string, SpellcheckDictionaryAssets>>
}

export type SpellcheckRequest =
	// First message: the engine, and every file URL of this build (older cached files are pruned).
	| { readonly type: "init"; readonly wasm: string; readonly current: readonly string[] }
	// Loads a dictionary and adds `words` (the user's) to it.
	| {
			readonly type: "load"
			readonly id: number
			readonly dictionary: string
			readonly files: SpellcheckDictionaryAssets
			readonly words: readonly string[]
	  }
	// `count` words, "\n"-joined.
	| { readonly type: "check"; readonly id: number; readonly dictionary: string; readonly words: string; readonly count: number }
	| { readonly type: "suggest"; readonly id: number; readonly dictionary: string; readonly word: string; readonly ngram: boolean }
	// Adds words to every loaded dictionary.
	| { readonly type: "add"; readonly words: readonly string[] }

export type SpellcheckResponse =
	| { readonly type: "loaded"; readonly id: number }
	| { readonly type: "checked"; readonly id: number; readonly verdicts: Uint8Array }
	| { readonly type: "suggested"; readonly id: number; readonly suggestions: readonly string[] }
	| { readonly type: "failed"; readonly id: number; readonly message: string }

// The transport to a worker, from the host's side (a Worker, or an in-thread loop in tests and hosts
// without workers).
export interface SpellcheckPort {
	post(message: SpellcheckRequest, transfer: readonly Transferable[]): void
	listen(onMessage: (message: SpellcheckResponse) => void, onError: () => void): void
	terminate(): void
}

// The worker's side of the transport.
export interface SpellcheckWorkerScope {
	post(message: SpellcheckResponse, transfer: readonly Transferable[]): void
	listen(onMessage: (message: SpellcheckRequest) => void): void
}

// Word lists are joined with this; no word contains it.
export const WORD_SEPARATOR = "\n"

// Longer "words" (identifiers, encoded data) are not checked, nor taken as the user's.
export const MAX_WORD_LENGTH = 100
