import { type } from "arktype"
import { create } from "zustand"
import { kvLoadOnce, kvSetJsonQuiet } from "@/lib/storage/kvBestEffort"
import { MAX_RECENT_EMOJIS, mergeRecentEmojis, pushRecentEmoji } from "@/features/chats/lib/emojiPicker.logic"

// The emoji picker's recently used list, newest first, as insert tokens (emojiPicker.logic.ts's emojiInsertText). Kept
// in kv on this device (logout wipes it, so it is per account), read the first time the picker opens.
const RECENTS_KV_KEY = "chats.emojiRecents.v1"

const recentsSchema = type("string[]")

interface EmojiRecentsStore {
	recents: string[]
	record: (token: string) => void
}

export const useEmojiRecents = create<EmojiRecentsStore>((set, get) => ({
	recents: [],
	record: token => {
		const next = pushRecentEmoji(get().recents, token)

		set({ recents: next })
		void kvSetJsonQuiet(RECENTS_KV_KEY, next, "chats", "recent emoji")
	}
}))

// Uses made before the read lands stay on top of what was stored.
export const loadEmojiRecents = kvLoadOnce(
	RECENTS_KV_KEY,
	recentsSchema,
	stored => {
		useEmojiRecents.setState(state => ({ recents: mergeRecentEmojis(state.recents, stored.slice(0, MAX_RECENT_EMOJIS)) }))
	},
	"chats",
	"recent emoji"
)
