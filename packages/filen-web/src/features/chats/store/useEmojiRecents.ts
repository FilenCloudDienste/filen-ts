import { type } from "arktype"
import { create } from "zustand"
import { kvLoadOnce, kvSetJsonQuiet } from "@/lib/storage/kvBestEffort"
import { MAX_RECENT_EMOJIS, mergeRecentEmojis, pushRecentEmoji } from "@/features/chats/lib/emojiPicker.logic"
import { SKIN_TONES, type SkinTone } from "@/features/chats/lib/skinTone"

// The emoji picker's recently used list, newest first, as recent tokens (emojiPicker.logic.ts's emojiRecentToken), and
// its skin tone. Kept in kv on this device (logout wipes it, so it is per account), read the first time the picker
// opens.
const RECENTS_KV_KEY = "chats.emojiRecents.v1"
const SKIN_TONE_KV_KEY = "chats.emojiSkinTone.v1"

const recentsSchema = type("string[]")
const skinToneSchema = type("0 | 1 | 2 | 3 | 4 | 5")

interface EmojiRecentsStore {
	recents: string[]
	skinTone: SkinTone
	// Whether a tone was chosen this session, so a late read of the stored one does not undo it.
	skinToneChosen: boolean
	record: (token: string) => void
	setSkinTone: (tone: SkinTone) => void
}

export const useEmojiRecents = create<EmojiRecentsStore>((set, get) => ({
	recents: [],
	skinTone: 0,
	skinToneChosen: false,
	record: token => {
		const next = pushRecentEmoji(get().recents, token)

		set({ recents: next })
		void kvSetJsonQuiet(RECENTS_KV_KEY, next, "chats", "recent emoji")
	},
	setSkinTone: tone => {
		set({ skinTone: tone, skinToneChosen: true })
		void kvSetJsonQuiet(SKIN_TONE_KV_KEY, tone, "chats", "emoji skin tone")
	}
}))

// Uses made before the read lands stay on top of what was stored.
const loadRecents = kvLoadOnce(
	RECENTS_KV_KEY,
	recentsSchema,
	stored => {
		useEmojiRecents.setState(state => ({ recents: mergeRecentEmojis(state.recents, stored.slice(0, MAX_RECENT_EMOJIS)) }))
	},
	"chats",
	"recent emoji"
)

const loadSkinTone = kvLoadOnce(
	SKIN_TONE_KV_KEY,
	skinToneSchema,
	stored => {
		const tone = SKIN_TONES.find(entry => entry === stored)

		if (tone !== undefined && !useEmojiRecents.getState().skinToneChosen) {
			useEmojiRecents.setState({ skinTone: tone })
		}
	},
	"chats",
	"emoji skin tone"
)

export async function loadEmojiRecents(): Promise<void> {
	await Promise.all([loadRecents(), loadSkinTone()])
}
