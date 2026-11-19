import { describe, expect, it } from "vitest"
import {
	classifyVideoLibrarySteps,
	type LibraryRootType,
	type LibraryScanDir,
	type LibraryScanFile,
	type LibraryScanInput,
	type VideoLibrary
} from "@filen/shared/videos"
import { syntheticLibrary } from "./syntheticLibrary"

// Golden output of the classifier, stepped one `next()` at a time the way the worker drives it: a digest per library,
// committed in __snapshots__. A rule change that classifies any of these libraries differently fails here; when the
// change is deliberate, bump CLASSIFIER_VERSION and regenerate with
// `pnpm vitest run src/tests/videos/classifyReference.test.ts -u` from packages/filen-shared.

function stepped(input: LibraryScanInput): { library: VideoLibrary; steps: number } {
	const steps = classifyVideoLibrarySteps(input)
	let count = 0
	let step = steps.next()

	while (step.done !== true) {
		count++
		step = steps.next()
	}

	return { library: step.value, steps: count }
}

// Canonical JSON (object keys sorted) so the digest depends on the output, not on property insertion order.
async function digest(library: VideoLibrary): Promise<string> {
	const json = JSON.stringify(library, (_key, value: unknown) =>
		value !== null && typeof value === "object" && !Array.isArray(value)
			? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
			: value
	)

	const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json)))

	return Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("")
}

function rng(seed: number): () => number {
	let state = seed >>> 0

	return () => {
		state = (state * 1_664_525 + 1_013_904_223) >>> 0

		return state / 2 ** 32
	}
}

// Names of every shape the classifier tells apart: movies with years, versions, parts and extras; series with
// seasons, specials, packs and loose episodes; camera clips; sidecars and art; ignored and unrelated files.
function randomLibrary(seed: number): LibraryScanInput {
	const random = rng(seed)
	const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)] as T
	const dirs: LibraryScanDir[] = []
	const files: LibraryScanFile[] = []
	let next = 0
	const dir = (parent: string, name: string): string => {
		const uuid = `d${String(next++)}`

		dirs.push({ uuid, parent, name })

		return uuid
	}
	const file = (parent: string, name: string): void => {
		files.push({
			uuid: `f${String(next++)}`,
			parent,
			name,
			size: Math.floor(random() * 4e9) + 1,
			timestamp: Math.floor(random() * 1e12)
		})
	}
	const titles = ["Heat", "Alien", "The Matrix", "Dune", "Up", "Léon", "Ronin", "Se7en", "Amélie", "2001 A Space Odyssey"]
	const shows = ["Lost", "The Wire", "Dark", "Fargo", "Twin Peaks"]
	const types: LibraryRootType[] = ["auto", "movies", "shows", "other"]
	const roots = Array.from({ length: 1 + Math.floor(random() * 3) }, (_, index) => ({
		uuid: `root${String(index)}`,
		name: `Root ${String(index)}`,
		type: pick(types)
	}))

	for (const root of roots) {
		for (let m = 0; m < 6 + Math.floor(random() * 10); m++) {
			const title = `${pick(titles)} (${String(1970 + Math.floor(random() * 50))})`
			const folder = random() < 0.7 ? dir(root.uuid, title) : root.uuid

			file(
				folder,
				`${title}${pick(["", " - 1080p", " - 2160p", " [Director's Cut]", ".cd1", " part2"])}.${pick(["mkv", "mp4", "avi", "ts"])}`
			)

			if (random() < 0.4) {
				file(folder, `${title}${pick(["", " - 720p", ".cd2", " part1"])}.mkv`)
			}

			if (random() < 0.5) {
				file(
					folder,
					pick([
						"poster.jpg",
						"fanart.jpg",
						`${title}-poster.png`,
						"folder.jpg",
						"movie.nfo",
						`${title}.en.srt`,
						`${title}.de.forced.ass`
					])
				)
			}

			if (random() < 0.2 && folder !== root.uuid) {
				file(
					dir(folder, pick(["Extras", "Featurettes", "Behind The Scenes", "Trailers"])),
					`${pick(["Making of", "Interview", "Trailer"])}.mkv`
				)
			}

			if (random() < 0.1) {
				file(folder, `${title}-${pick(["trailer", "sample", "deleted", "featurette"])}.mkv`)
			}
		}

		for (let s = 0; s < 1 + Math.floor(random() * 3); s++) {
			const name = pick(shows)
			const show = random() < 0.8 ? dir(root.uuid, random() < 0.5 ? name : `${name} (${String(2000 + s)})`) : root.uuid

			if (random() < 0.5) {
				file(show, pick(["tvshow.nfo", "poster.jpg", "season01-poster.jpg"]))
			}

			for (let season = random() < 0.3 ? 0 : 1; season <= 1 + Math.floor(random() * 3); season++) {
				const seasonDir =
					random() < 0.2
						? show
						: dir(
								show,
								season === 0
									? pick(["Specials", "Season 0"])
									: pick([
											`Season ${String(season)}`,
											`S${String(season).padStart(2, "0")}`,
											`${name} S0${String(season)} 1080p`
										])
							)

				for (let episode = 1; episode <= 2 + Math.floor(random() * 6); episode++) {
					const code = `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`
					const stem = pick([
						`${name} ${code}`,
						`${name}.${code}.Episode.Title.1080p.WEB-DL`,
						`${name} - ${String(season)}x${String(episode).padStart(2, "0")} - Title`,
						`${name} ${code}-E${String(episode + 1).padStart(2, "0")}`,
						`Episode ${String(episode)}`
					])

					file(seasonDir, `${stem}.${pick(["mkv", "mp4"])}`)

					if (random() < 0.3) {
						file(seasonDir, `${stem}.${pick(["en", "de", "fr.sdh"])}.srt`)
					}
				}
			}
		}

		if (random() < 0.6) {
			const camera = dir(root.uuid, pick(["Camera", "DCIM", "Phone 2023", "Holiday Lisbon"]))

			for (let clip = 0; clip < 3 + Math.floor(random() * 8); clip++) {
				file(
					camera,
					pick([
						`VID_2023010${String(clip)}_101010.mp4`,
						`IMG_${String(clip)}.MOV`,
						`PXL_2023${String(clip)}.mp4`,
						`IMG_${String(clip)}.jpg`
					])
				)
			}
		}

		if (random() < 0.4) {
			const ignored = dir(root.uuid, pick([".hidden", "@eaDir", "#recycle", "Sample", "lost+found"]))

			file(ignored, "something.mkv")
		}

		file(root.uuid, pick(["notes.txt", "desktop.ini", ".DS_Store", "readme.md"]))
	}

	return { roots, dirs, files }
}

describe("sliced classifier", () => {
	it("classifies 40 mixed libraries to their golden output", async () => {
		const digests: Record<string, string> = {}

		for (let seed = 1; seed <= 40; seed++) {
			digests[`seed ${String(seed)}`] = await digest(stepped(randomLibrary(seed)).library)
		}

		expect(digests).toMatchSnapshot()
	})

	it("covers movies with versions and extras, series, and other videos across the mixed libraries", () => {
		const libraries = Array.from({ length: 40 }, (_, index) => stepped(randomLibrary(index + 1)).library)

		expect(libraries.every(library => library.movies.length + library.series.length + library.others.length > 0)).toBe(true)
		expect(libraries.some(library => library.movies.some(movie => movie.versions.length > 1))).toBe(true)
		expect(libraries.some(library => library.movies.some(movie => movie.extras.length > 0))).toBe(true)
		expect(libraries.some(library => library.series.some(series => series.seasons.length > 1))).toBe(true)
		expect(libraries.some(library => library.others.length > 0)).toBe(true)
	})

	it("classifies a 50k-file library to its golden output, one step at a time", async () => {
		const { library, steps } = stepped(syntheticLibrary(50_000))

		expect(steps).toBeGreaterThan(1000)
		expect(await digest(library)).toMatchSnapshot()
	})
})
