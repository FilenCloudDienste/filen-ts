import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const CSS = readFileSync("src/index.css", "utf8")

function sources(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
		const path = join(directory, entry.name)

		if (entry.isDirectory()) {
			return entry.name === "tests" ? [] : sources(path)
		}

		return /\.tsx?$/u.test(entry.name) ? [path] : []
	})
}

describe("dynamic-range-limit scope", () => {
	it("is declared only by the thumbnail utility, never inherited from a root rule", () => {
		const declarations = CSS.match(/dynamic-range-limit:/gu) ?? []

		expect(declarations).toHaveLength(1)
		expect(CSS).toMatch(/@utility thumbnail-range \{\s*dynamic-range-limit: standard;\s*\}/u)
	})

	it("limits the thumbnail and artwork surfaces only", () => {
		const users = sources("src")
			.filter(path => readFileSync(path, "utf8").includes("thumbnail-range"))
			.map(path => path.replaceAll("\\", "/"))
			.sort()

		expect(users).toEqual([
			"src/features/audio/components/audioPlayerBar.tsx",
			"src/features/audio/components/nowPlayingPanel.tsx",
			"src/features/audio/components/playlistArtwork.tsx",
			"src/features/audio/components/playlistPane.tsx",
			"src/features/drive/components/itemThumbnail.tsx",
			"src/features/videos/components/player/upNextCard.tsx",
			"src/features/videos/components/videoCard.tsx"
		])
	})

	it("sets no limit by hand anywhere else", () => {
		const arbitrary = sources("src").filter(path => readFileSync(path, "utf8").includes("dynamic-range-limit"))

		expect(arbitrary).toEqual([])
	})
})
