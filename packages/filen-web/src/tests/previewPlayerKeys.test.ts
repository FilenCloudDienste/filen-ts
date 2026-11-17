import { describe, expect, it } from "vitest"
import { MEDIA_ACTIONS } from "@/lib/media/keymap"
import { mediaKeyAction } from "@/lib/media/mediaKeys.logic"
import { previewVideoActions } from "@/lib/media/playerKeyboard"

function pageKey(code: "PageUp" | "PageDown", chapters: number): string | null {
	return mediaKeyAction(
		{ code, key: code, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false },
		"surface",
		previewVideoActions(false, chapters),
		{},
		false
	)
}

describe("the preview video player's chapter keys", () => {
	it("takes PageUp and PageDown only from two chapters on, leaving them to what is around it otherwise", () => {
		expect(pageKey("PageUp", 0)).toBeNull()
		expect(pageKey("PageDown", 1)).toBeNull()
		expect(pageKey("PageUp", 2)).toBe("media.chapterPrevious")
		expect(pageKey("PageDown", 5)).toBe("media.chapterNext")
		expect(previewVideoActions(true, 2)).toContain("media.fullscreen")
	})

	it("lists them as keys of any video player", () => {
		const hints = MEDIA_ACTIONS.filter(action => action.id === "media.chapterPrevious" || action.id === "media.chapterNext").map(
			action => action.hintKey
		)

		expect(hints).toEqual(["videos:mediaHintVideo", "videos:mediaHintVideo"])
	})
})
