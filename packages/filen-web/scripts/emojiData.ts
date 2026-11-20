import { readFileSync, writeFileSync } from "node:fs"
import { EMOJI_DATA_OUTPUT, emojiDataModule } from "./emojiDataSource"

// Writes src/features/chats/lib/emojiData.gen.ts, the chat emoji picker's full emoji set, from the emojibase-data
// devDependency (scripts/emojiDataSource.ts). Re-run after bumping emojibase-data. With --check it writes nothing and
// fails when the committed file differs (src/tests/chatsEmojiData.test.ts runs it so).
//
//   pnpm exec tsx scripts/emojiData.ts [--check]

const source = emojiDataModule()

if (process.argv.includes("--check")) {
	if (readFileSync(EMOJI_DATA_OUTPUT, "utf8") !== source) {
		throw new Error(`${EMOJI_DATA_OUTPUT} is not what scripts/emojiData.ts generates: re-run it`)
	}
} else {
	writeFileSync(EMOJI_DATA_OUTPUT, source)
}
