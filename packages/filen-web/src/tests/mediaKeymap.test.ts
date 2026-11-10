import { beforeEach, describe, expect, it, vi } from "vitest"
import { MEDIA_ACTIONS } from "@/lib/media/keymap"
import { VIDEOS_CARD_ACTIONS } from "@/features/videos/lib/keymap"
import { cardCommand, cardCommandAction } from "@/features/videos/lib/cardKeys"
import { AUDIO_BAR_MEDIA_ACTIONS, audioSeekTarget, runAudioMediaAction, type AudioKeyTransport } from "@/features/audio/lib/barKeys"
import { STAGE_MEDIA_ACTIONS } from "@/lib/media/videoKeys.logic"

// The media keys (one set for every player) and the video cards' commands: their registry contract, and what the
// audio bar and the cards do with them.
const { kvStore } = vi.hoisted(() => ({ kvStore: new Map<string, unknown>() }))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(kvStore.get(key) ?? null),
	kvSetJson: (key: string, value: unknown) => {
		kvStore.set(key, value)

		return Promise.resolve()
	}
}))

async function freshRegistry() {
	vi.resetModules()

	return import("@/lib/keymap/registry")
}

beforeEach(() => {
	kvStore.clear()
})

function keydown(code: string, key: string, shiftKey = false) {
	return { code, key, ctrlKey: false, metaKey: false, shiftKey, altKey: false }
}

describe("MEDIA_ACTIONS", () => {
	it("are one media group whose keys stay on with single-key shortcuts off, as they act only in a focused player", () => {
		for (const def of MEDIA_ACTIONS) {
			expect(def.scope, def.id).toBe("media")
			expect(def.keepsCharacterKeys, def.id).toBe(true)
		}
	})

	it("are all taken by the Videos player, and the audio bar takes a subset", () => {
		const ids = new Set<string>(MEDIA_ACTIONS.map(def => def.id))

		expect(new Set(STAGE_MEDIA_ACTIONS)).toEqual(ids)

		for (const id of AUDIO_BAR_MEDIA_ACTIONS) {
			expect(ids.has(id), id).toBe(true)
		}
	})

	it("resolve to their defaults, follow an override and keep their single keys with those switched off", async () => {
		const { registerAction, comboFor, setUserCombo, setCharacterKeys } = await freshRegistry()

		for (const def of MEDIA_ACTIONS) {
			registerAction(def)
		}

		expect(comboFor("media.playPause")).toBe("space,k")
		expect(comboFor("media.close")).toBe("escape")
		expect(comboFor("media.subtitleDelayReset")).toBe("")

		await setUserCombo("media.mute", "u")
		await setCharacterKeys(false)

		expect(comboFor("media.mute")).toBe("u")
		expect(comboFor("media.seekBack")).toBe("arrowleft,j")
	})
})

describe("video card commands", () => {
	it("match the defaults and follow an override", () => {
		expect(cardCommand(keydown("Space", " "), {}, false)).toBe("play")
		expect(cardCommand(keydown("KeyP", "p"), {}, false)).toBe("play")
		expect(cardCommand(keydown("KeyW", "w"), {}, false)).toBe("toggleWatched")
		expect(cardCommand(keydown("KeyP", "P", true), {}, false)).toBeNull()
		expect(cardCommand(keydown("KeyH", "h"), {}, false)).toBeNull()
		expect(cardCommand(keydown("KeyH", "h"), { "videos.hide": "h" }, false)).toBe("hide")
		expect(cardCommand(keydown("KeyW", "w"), { "videos.toggleWatched": "none" }, false)).toBeNull()
	})

	it("leave a key an input method is composing with", () => {
		expect(cardCommand({ ...keydown("KeyP", "Process"), isComposing: true }, {}, false)).toBeNull()
	})

	it("do what the card's menu would, and nothing where the menu has no such item", () => {
		const card = { play: "file", unsupported: false, badge: null, hideable: true }

		expect(cardCommandAction("play", card)).toBe("play")
		expect(cardCommandAction("play", { ...card, play: null })).toBeNull()
		expect(cardCommandAction("toggleWatched", card)).toBe("markWatched")
		expect(cardCommandAction("toggleWatched", { ...card, badge: { kind: "watched" } })).toBe("markUnwatched")
		expect(cardCommandAction("toggleWatched", { ...card, unsupported: true })).toBeNull()
		expect(cardCommandAction("hide", card)).toBe("hide")
		expect(cardCommandAction("hide", { ...card, hideable: false })).toBeNull()
	})

	it("are registered on the videos screens", () => {
		for (const def of VIDEOS_CARD_ACTIONS) {
			expect(def.scope).toBe("videos")
		}
	})
})

describe("the audio bar's media keys", () => {
	function engine() {
		const seeks: number[] = []
		const calls: string[] = []
		const transport: AudioKeyTransport = {
			toggle: () => {
				calls.push("toggle")
			},
			seek: seconds => {
				seeks.push(seconds)
			},
			skipNext: () => {
				calls.push("next")

				return Promise.resolve()
			},
			skipPrevious: () => {
				calls.push("previous")

				return Promise.resolve()
			}
		}

		return { seeks, calls, transport }
	}

	it("seek inside the track, by the one seek step", () => {
		const { seeks, transport } = engine()

		runAudioMediaAction("media.seekForward", transport, { position: 100, duration: 200 })
		runAudioMediaAction("media.seekBack", transport, { position: 5, duration: 200 })
		runAudioMediaAction("media.seekForwardLong", transport, { position: 180, duration: 200 })
		runAudioMediaAction("media.jump.fifty", transport, { position: 0, duration: 200 })
		runAudioMediaAction("media.toStart", transport, { position: 50, duration: 200 })

		expect(seeks).toEqual([110, 0, 200, 100, 0])
	})

	it("leave the jumps and the end alone while the length is unknown", () => {
		const { seeks, transport } = engine()

		runAudioMediaAction("media.jump.fifty", transport, { position: 0, duration: 0 })
		runAudioMediaAction("media.toEnd", transport, { position: 0, duration: 0 })

		expect(seeks).toEqual([])
	})

	it("play, pause and skip through the engine", () => {
		const { calls, transport } = engine()

		runAudioMediaAction("media.playPause", transport, { position: 0, duration: 0 })
		runAudioMediaAction("media.next", transport, { position: 0, duration: 0 })
		runAudioMediaAction("media.previous", transport, { position: 0, duration: 0 })

		expect(calls).toEqual(["toggle", "next", "previous"])
	})

	it("clamp a seek to the track once its length is known", () => {
		expect(audioSeekTarget(-3, 100)).toBe(0)
		expect(audioSeekTarget(130, 100)).toBe(100)
		expect(audioSeekTarget(130, 0)).toBe(130)
	})
})
