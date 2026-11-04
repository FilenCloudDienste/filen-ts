import type { SpellingChecker } from "@filen/office/core/docx/spelling"
import type { SpellcheckResponse } from "@filen/spellcheck"
import { SpellcheckHost } from "@filen/spellcheck/host"
import { SPELLCHECK_ASSETS } from "virtual:spellcheck-assets"
import SpellcheckWorker from "@/features/spellcheck/workers/spellcheck.worker.ts?worker"
import { recoverIfNewerBuild } from "@/lib/appUpdate"
import { log } from "@/lib/log"
import { userDictionary } from "@/features/spellcheck/lib/userDictionary"

// The page's spellchecker: verdicts cached here, checks in one worker, suggestions in another (each ends
// after a quiet spell or once no document is open, which is when a dictionary's memory goes). Nothing starts
// until a document is checked.
export const spellcheck = new SpellcheckHost({
	assets: SPELLCHECK_ASSETS,
	createWorker: () => {
		const worker = new SpellcheckWorker()

		return {
			post(message, transfer) {
				worker.postMessage(message, [...transfer])
			},
			listen(onMessage, onError) {
				worker.addEventListener("message", (event: MessageEvent<SpellcheckResponse>) => {
					onMessage(event.data)
				})
				worker.addEventListener("error", () => {
					// A deploy that changed this worker removes its old file (appUpdate.ts).
					recoverIfNewerBuild()
					onError()
				})
			},
			terminate() {
				worker.terminate()
			}
		}
	}
})

let userWordsFollowed = false

// The user's dictionary feeds the spellchecker from the first check on, before any verdict is shown.
function followUserWords(): Promise<void> {
	if (!userWordsFollowed) {
		userWordsFollowed = true
		spellcheck.setUserWords(userDictionary.words())
		userDictionary.subscribe(words => {
			spellcheck.setUserWords(words)
		})
	}

	return userDictionary.load().catch((error: unknown) => {
		log.warn("spellcheck", "user dictionary not loaded", { error })
	})
}

// What document spelling (@filen/office DocxSpelling) checks with on web.
export const documentSpellingChecker: SpellingChecker = {
	dictionaryFor: language => spellcheck.dictionaryFor(language),
	known: (dictionary, word) => spellcheck.known(dictionary, word),
	check: async (dictionary, words) => {
		await Promise.all([followUserWords(), spellcheck.check(dictionary, words)])
	},
	suggest: (dictionary, word, options) => spellcheck.suggest(dictionary, word, options),
	// Applied at once (the spellchecker hears the change); the upload continues on its own.
	addToDictionary: word => {
		void followUserWords()
		userDictionary.add(word).catch((error: unknown) => {
			log.warn("spellcheck", "user dictionary not saved", { error })
		})

		return Promise.resolve()
	},
	subscribe: listener => spellcheck.subscribe(listener),
	// The workers and verdicts go once no document is open.
	open: () => spellcheck.open()
}

// The language for text that names none: the browser's (the user's locale, with its region).
export function defaultSpellingLanguage(): string {
	return typeof navigator === "undefined" ? "en-US" : navigator.language
}
