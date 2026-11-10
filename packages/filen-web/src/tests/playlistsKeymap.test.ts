// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Playlist, PlaylistFile } from "@filen/shared"
import type { PlaylistEntry } from "@/features/audio/queries/playlists"
import { PLAYLISTS_ACTIONS } from "@/features/audio/lib/playlistKeymap"
import { playlistForKeyTarget, trackMoveTarget, trackUuidOf } from "@/features/audio/lib/playlistKeys.logic"

// The registry's only storage boundary, as every other keymap test stubs it.
const { kvStore } = vi.hoisted(() => ({ kvStore: new Map<string, unknown>() }))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(kvStore.get(key) ?? null),
	kvSetJson: (key: string, value: unknown) => {
		kvStore.set(key, value)

		return Promise.resolve()
	},
	kvDelete: (key: string) => {
		kvStore.delete(key)

		return Promise.resolve()
	}
}))

async function freshRegistry() {
	vi.resetModules()

	return import("@/lib/keymap/registry")
}

function track(uuid: string): PlaylistFile {
	return {
		uuid,
		name: `${uuid}.mp3`,
		mime: "audio/mpeg",
		size: 1,
		bucket: "b",
		key: "k",
		version: 2,
		chunks: 1,
		region: "r",
		playlist: "p"
	}
}

function playlist(uuid: string, tracks: readonly string[] = []): Playlist {
	return { uuid, name: uuid, created: 0, updated: 0, files: tracks.map(track) }
}

function ok(entry: Playlist): PlaylistEntry {
	return { status: "ok", playlist: entry }
}

beforeEach(() => {
	kvStore.clear()
})

afterEach(() => {
	document.body.replaceChildren()
})

describe("PLAYLISTS_ACTIONS", () => {
	it("live in the playlists scope under the playlists namespace", () => {
		for (const def of PLAYLISTS_ACTIONS) {
			expect(def.scope, def.id).toBe("playlists")
			expect(def.id.startsWith("playlists."), def.id).toBe(true)
		}
	})

	it("leave add tracks, play and shuffle unset", () => {
		for (const id of ["playlists.addTracks", "playlists.play", "playlists.shuffle"]) {
			expect(PLAYLISTS_ACTIONS.find(def => def.id === id)?.defaultCombo, id).toBe("")
		}
	})

	it("resolve to their defaults, and to a user's override", async () => {
		const { registerAction, comboFor, setUserCombo } = await freshRegistry()

		for (const def of PLAYLISTS_ACTIONS) {
			registerAction(def)
		}

		expect(comboFor("playlists.newPlaylist")).toBe("n")
		expect(comboFor("playlists.delete")).toBe("delete,backspace")
		expect(comboFor("playlists.moveTrackUp")).toBe("alt+shift+arrowup")

		await setUserCombo("playlists.rename", "mod+r")

		expect(comboFor("playlists.rename")).toBe("mod+r")
	})
})

describe("playlistForKeyTarget", () => {
	const shown = playlist("shown")
	const other = playlist("other")
	const entries: PlaylistEntry[] = [ok(shown), ok(other), { status: "degraded", fileUuid: "broken", name: "broken" }]

	function sidebarRow(uuid: string): HTMLElement {
		const row = document.createElement("li")
		const link = document.createElement("a")

		row.setAttribute("data-playlist-uuid", uuid)
		row.append(link)
		document.body.append(row)

		return link
	}

	it("takes the playlist whose sidebar row holds focus", () => {
		expect(playlistForKeyTarget(entries, shown, sidebarRow("other"))).toBe(other)
	})

	it("falls back to the one on screen outside the sidebar rows", () => {
		expect(playlistForKeyTarget(entries, shown, document.body)).toBe(shown)
		expect(playlistForKeyTarget(entries, shown, null)).toBe(shown)
	})

	it("falls back to the one on screen for a row no longer listed", () => {
		expect(playlistForKeyTarget(entries, shown, sidebarRow("gone"))).toBe(shown)
	})

	it("has no target while nothing is on screen and no row holds focus", () => {
		expect(playlistForKeyTarget(entries, null, document.body)).toBeNull()
	})
})

describe("track moves", () => {
	const list = playlist("p", ["a", "b", "c"])

	it("swap with the neighbour in the move's direction", () => {
		expect(trackMoveTarget(list, "b", -1)).toBe("a")
		expect(trackMoveTarget(list, "b", 1)).toBe("c")
	})

	it("stop at either end and for a track no longer listed", () => {
		expect(trackMoveTarget(list, "a", -1)).toBeNull()
		expect(trackMoveTarget(list, "c", 1)).toBeNull()
		expect(trackMoveTarget(list, "gone", 1)).toBeNull()
	})

	it("only fire with focus in a track row", () => {
		const row = document.createElement("tr")
		const button = document.createElement("button")

		row.setAttribute("data-track-uuid", "b")
		row.append(button)
		document.body.append(row)

		expect(trackUuidOf(button)).toBe("b")
		expect(trackUuidOf(document.body)).toBeNull()
	})
})
