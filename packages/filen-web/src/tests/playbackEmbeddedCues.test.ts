import { describe, expect, it } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { EmbeddedCues } from "@/lib/media/playback/embeddedCues"
import type { RemuxTextCue } from "@/lib/media/remuxTypes"

function cue(track: number, start: number, text: string): RemuxTextCue {
	return { track, start, end: start + 1, text, hint: 0 }
}

const all = (): boolean => true

describe("EmbeddedCues", () => {
	it("tells a track stale until its store is read, and rebuilds only a track that grew", () => {
		const embedded = new EmbeddedCues()

		expect(embedded.stale(3)).toBe(false)
		expect([...embedded.add([cue(3, 1, "a"), cue(4, 1, "x")], all)]).toEqual([3, 4])
		expect(embedded.stale(3)).toBe(true)

		const store = embedded.store(3)

		expect(store?.texts).toEqual(["a"])
		expect(embedded.stale(3)).toBe(false)
		expect([...embedded.add([cue(3, 1, "a"), cue(4, 2, "y")], all)]).toEqual([4])
		expect(embedded.store(3)).toBe(store)
		expect(embedded.stale(4)).toBe(true)
	})

	it("forgets every cue on clear, so the same cues count as new for the next file", () => {
		const embedded = new EmbeddedCues()

		embedded.add([cue(3, 1, "a")], all)
		embedded.clear()

		expect(embedded.store(3)).toBeNull()
		expect(embedded.stale(3)).toBe(false)
		expect([...embedded.add([cue(3, 1, "a")], all)]).toEqual([3])
	})
})

// Drift guard: the videos player and the drive preview keep embedded cues through EmbeddedCues alone, so the
// dedupe and the character budget can't differ between them.
function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
		const path = join(dir, entry.name)

		if (entry.isDirectory()) {
			return entry.name === "tests" ? [] : sourceFiles(path)
		}

		return /\.tsx?$/.test(entry.name) ? [path] : []
	})
}

describe("embedded cue budget", () => {
	it("is applied by the remux taps and EmbeddedCues only", () => {
		const owners = new Set([
			join("src", "workers", "remux", "textTap.ts"),
			join("src", "workers", "remux", "mp4TextTap.ts"),
			join("src", "lib", "media", "playback", "embeddedCues.ts")
		])

		expect(
			sourceFiles("src").filter(
				file => !owners.has(file) && /\b(?:MAX_EMBEDDED_CUE_CHARS|embeddedCueCharge)\b/.test(readFileSync(file, "utf8"))
			)
		).toEqual([])
	})
})
