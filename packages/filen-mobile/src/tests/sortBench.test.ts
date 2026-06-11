/**
 * TEMP performance benchmark for src/lib/sort.ts (itemSorter + notesSorter).
 *
 * Gated behind SORT_BENCH=1 so the normal suite skips it. Run with:
 *
 *   SORT_BENCH=1 npx vitest run src/tests/sortBench.test.ts
 *
 * Knobs (env): SORT_BENCH_SAMPLES (default 5), SORT_BENCH_WARMUP (default 2),
 * SORT_BENCH_SCALES (default "10000,100000"), SORT_BENCH_OUT (table file, default
 * /tmp/sortBench-out.txt — vitest swallows console output of passing non-TTY runs).
 *
 * Methodology (mirrors offlineBench/cameraUploadBench): per scenario — untimed prepare,
 * one untimed VALIDATION run checked against an INDEPENDENT reference comparator (the
 * drift canary: written once against current semantics and never changed during perf
 * rounds), then WARMUP warmups + SAMPLES timed runs, state restored outside the timed
 * region. Reported: min / median / mean ms.
 *
 * Fixture fidelity (CRITICAL): production DriveItems carry BIGINT timestamp/modified/
 * created/size (SDK types) — sort.test.ts uses plain numbers, which hides the
 * per-comparison Number(bigint) cost entirely. This bench uses bigint fields.
 *
 * Cache realism: sort.ts memoizes lowercase names / numeric parts / uuid numbers in
 * module-level Maps. WARM scenarios re-sort a fixed item set (steady-state: same folder
 * re-sorted on every data change). COLD scenarios regenerate all strings per run (first
 * visit of a large folder / photos library). PRESORTED scenarios feed an already-sorted
 * array (TimSort adaptive case — the most common on-device shape: a refetch re-sorting
 * an almost-unchanged listing).
 */
import { describe, it, expect, afterAll, vi } from "vitest"
import { writeFileSync } from "node:fs"

vi.mock("@/lib/i18n", () => ({
	default: {
		t: (key: string) => key
	}
}))

vi.mock("@/lib/time", () => ({
	intlLanguage: "en-US"
}))

import { itemSorter, notesSorter, type SortByType } from "@/lib/sort"
import { type DriveItem, type Note } from "@/types"

const BENCH = process.env["SORT_BENCH"] === "1"
const SAMPLES = Number(process.env["SORT_BENCH_SAMPLES"] ?? 5)
const WARMUP = Number(process.env["SORT_BENCH_WARMUP"] ?? 2)
// Explicitly typed: CI runs without the gitignored expo-env.d.ts, where process.env
// indexing degrades to `any` and the chain below trips noImplicitAny.
const SCALES_ENV: string = process.env["SORT_BENCH_SCALES"] ?? "10000,100000"
const SCALES = SCALES_ENV.split(",")
	.map(value => Number(value.trim()))
	.filter(value => Number.isFinite(value) && value > 0)
const OUT_FILE = process.env["SORT_BENCH_OUT"] ?? "/tmp/sortBench-out.txt"

type Row = {
	name: string
	scale: number
	minMs: number
	medianMs: number
	meanMs: number
	samples: number
}

const rows: Row[] = []

// ─── fixtures ────────────────────────────────────────────────────────────────

const TYPE_CYCLE: string[] = [
	"file",
	"file",
	"file",
	"file",
	"file",
	"file",
	"file",
	"file",
	"sharedFile",
	"directory",
	"file",
	"file",
	"sharedFile",
	"file",
	"sharedDirectory",
	"file",
	"file",
	"file",
	"sharedRootFile",
	"sharedRootDirectory"
]

function makeUuid(i: number, salt: string): string {
	return `${String(i % 100_000_000).padStart(8, "0")}-${salt.padEnd(4, "0").slice(0, 4)}-4000-8000-${String((i * 7919) % 1_000_000_000_000).padStart(12, "0")}`
}

function makeName(i: number, salt: string): string {
	const bucket = i % 10

	if (bucket < 6) {
		// Camera-style cyclical names: heavy shared text parts + numeric runs.
		return `IMG_${salt}${String(i % 9999).padStart(4, "0")}.JPG`
	}

	if (bucket < 9) {
		return `${salt}Document ${i} (v${i % 10}) final.pdf`
	}

	// Deliberate duplicate names (ties → stability paths).
	return `${salt}duplicate-name.dat`
}

function buildDriveItems(n: number, salt: string): DriveItem[] {
	const items: DriveItem[] = new Array(n)
	const baseTs = 1_700_000_000_000

	for (let i = 0; i < n; i++) {
		const type = TYPE_CYCLE[i % TYPE_CYCLE.length] ?? "file"
		// ~5% timestamp collisions to exercise the uuid tiebreak path.
		const ts = baseTs + (i % 20 === 0 ? 777_777 : (i * 7919) % 1_000_000_000)
		const isFileClass = type === "file" || type === "sharedFile" || type === "sharedRootFile"

		items[i] = {
			type,
			data: {
				uuid: makeUuid(i, salt),
				size: BigInt((i * 104729) % 10_000_000_000),
				timestamp: BigInt(ts),
				decryptedMeta: {
					name: makeName(i, salt),
					mime: isFileClass ? (i % 3 === 0 ? "image/jpeg" : i % 3 === 1 ? "application/pdf" : "video/mp4") : undefined,
					modified: BigInt(ts + ((i * 31) % 86_400_000)),
					created: BigInt(ts - ((i * 17) % 86_400_000))
				},
				undecryptable: false
			}
		} as unknown as DriveItem
	}

	return items
}

function buildNotes(n: number, salt: string): Note[] {
	const notes: Note[] = new Array(n)
	const nowMs = 1_750_000_000_000
	const day = 24 * 60 * 60 * 1000

	for (let i = 0; i < n; i++) {
		// Spread across all buckets: today / 7d / 30d / month / several years.
		const ageDays = (i * 13) % 1500
		const ts = BigInt(nowMs - ageDays * day - ((i * 7919) % day))

		notes[i] = {
			uuid: makeUuid(i, salt),
			ownerId: 1n,
			lastEditorId: 1n,
			favorite: i % 17 === 0,
			pinned: i % 23 === 0,
			tags:
				i % 4 === 0
					? [
							{
								uuid: `tag-${i % 8}`,
								name: `tag${i % 8}`,
								favorite: false,
								editedTimestamp: 1000n,
								createdTimestamp: 1000n,
								undecryptable: false
							}
						]
					: [],
			noteType: "text",
			trash: i % 29 === 0,
			archive: i % 31 === 0,
			undecryptable: false,
			editedTimestamp: i % 41 === 0 ? ts : ts + 1n,
			createdTimestamp: ts,
			participants: []
		} as unknown as Note
	}

	return notes
}

// ─── independent reference comparators (the drift canary — DO NOT change during
// perf rounds; they encode the CURRENT semantics of sort.ts) ────────────────────

function refIsDir(type: string): boolean {
	return type === "directory" || type === "sharedDirectory" || type === "sharedRootDirectory"
}

function refNumericParts(str: string): (string | number)[] {
	const parts: (string | number)[] = []
	const matches = str.match(/\d+|\D+/g) ?? []

	for (const part of matches) {
		if (/^\d+$/.test(part)) {
			parts.push(parseInt(part, 10))
		} else {
			parts.push(part)
		}
	}

	return parts
}

function refCompareStringsNumeric(a: string, b: string): number {
	const aParts = refNumericParts(a)
	const bParts = refNumericParts(b)
	const minLen = Math.min(aParts.length, bParts.length)

	for (let i = 0; i < minLen; i++) {
		const aPart = aParts[i]
		const bPart = bParts[i]

		if (typeof aPart === "number" && typeof bPart === "number") {
			if (aPart !== bPart) {
				return aPart - bPart
			}
		} else if (typeof aPart === "string" && typeof bPart === "string") {
			if (aPart !== bPart) {
				return aPart < bPart ? -1 : 1
			}
		} else {
			return typeof aPart === "number" ? -1 : 1
		}
	}

	return aParts.length - bParts.length
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function refNameKey(item: any): string {
	return String(item.data.decryptedMeta?.name ?? item.data.uuid).toLowerCase()
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function refMimeKey(item: any): string {
	const isFileClass = item.type === "file" || item.type === "sharedFile" || item.type === "sharedRootFile"

	return String(
		isFileClass
			? (item.data.decryptedMeta?.mime ?? item.data.decryptedMeta?.name ?? item.data.uuid)
			: (item.data.decryptedMeta?.name ?? item.data.uuid)
	).toLowerCase()
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function refDateKey(item: any): number {
	return Number(
		item.type === "file"
			? item.data.timestamp
			: item.type === "directory"
				? item.data.timestamp
				: item.type === "sharedFile" || item.type === "sharedRootFile"
					? (item.data.decryptedMeta?.created ?? item.data.decryptedMeta?.modified ?? 0)
					: (item.data.decryptedMeta?.created ?? 0)
	)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function refLastModifiedKey(item: any): number {
	return Number(
		item.type === "file"
			? (item.data.decryptedMeta?.modified ?? item.data.timestamp)
			: item.type === "directory"
				? (item.data.decryptedMeta?.created ?? item.data.timestamp)
				: item.type === "sharedFile" || item.type === "sharedRootFile"
					? (item.data.decryptedMeta?.modified ?? item.data.decryptedMeta?.created ?? 0)
					: (item.data.decryptedMeta?.created ?? 0)
	)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function refCreationKey(item: any): number {
	return Number(
		item.type === "file"
			? (item.data.decryptedMeta?.created ?? item.data.timestamp)
			: item.type === "directory"
				? (item.data.decryptedMeta?.created ?? item.data.timestamp)
				: item.type === "sharedFile" || item.type === "sharedRootFile"
					? (item.data.decryptedMeta?.created ?? item.data.decryptedMeta?.modified ?? 0)
					: (item.data.decryptedMeta?.created ?? 0)
	)
}

function refUuidNumber(uuid: string): number {
	const digits = uuid.replace(/\D/g, "").slice(0, 16)

	return digits.length > 0 ? parseInt(digits, 10) : 0
}

// Pairwise "a may precede b" check per mode. Returns <= 0 when the adjacent order is
// legal (ties allowed — stability is checked by the hardening suite, not here).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function refCompare(mode: SortByType, a: any, b: any): number {
	const aDir = refIsDir(a.type)
	const bDir = refIsDir(b.type)

	if (aDir && !bDir) {
		return -1
	}

	if (bDir && !aDir) {
		return 1
	}

	const asc = mode.endsWith("Asc")

	switch (mode) {
		case "nameAsc":
		case "nameDesc": {
			const result = refCompareStringsNumeric(refNameKey(a), refNameKey(b))

			return asc ? result : -result
		}

		case "mimeAsc":
		case "mimeDesc": {
			const result = refCompareStringsNumeric(refMimeKey(a), refMimeKey(b))

			return asc ? result : -result
		}

		case "sizeAsc":
		case "sizeDesc": {
			const cmp = a.data.size > b.data.size ? 1 : a.data.size < b.data.size ? -1 : 0

			return asc ? cmp : -cmp
		}

		default: {
			const key = mode.startsWith("uploadDate") ? refDateKey : mode.startsWith("lastModified") ? refLastModifiedKey : refCreationKey
			const aTs = key(a)
			const bTs = key(b)

			if (aTs === bTs) {
				const diff = refUuidNumber(a.data.uuid) - refUuidNumber(b.data.uuid)

				return asc ? diff : -diff
			}

			const diff = aTs - bTs

			return asc ? diff : -diff
		}
	}
}

function validateSorted(mode: SortByType, input: DriveItem[], output: DriveItem[]): void {
	expect(output).toHaveLength(input.length)

	for (let i = 1; i < output.length; i++) {
		const cmp = refCompare(mode, output[i - 1], output[i])

		if (cmp > 0) {
			throw new Error(`reference-order violation in mode ${mode} at index ${i} (cmp=${cmp})`)
		}
	}
}

// ─── harness ─────────────────────────────────────────────────────────────────

async function runScenario({
	name,
	scale,
	prepare,
	run,
	validate
}: {
	name: string
	scale: number
	prepare?: () => unknown
	run: (prepared: unknown) => unknown
	validate?: (result: unknown, prepared: unknown) => void
}): Promise<void> {
	let prepared = prepare ? prepare() : undefined
	const validationResult = run(prepared)

	if (validate) {
		validate(validationResult, prepared)
	}

	for (let i = 0; i < WARMUP; i++) {
		prepared = prepare ? prepare() : undefined

		run(prepared)
	}

	const timings: number[] = []

	for (let i = 0; i < SAMPLES; i++) {
		prepared = prepare ? prepare() : undefined

		const start = performance.now()

		run(prepared)

		timings.push(performance.now() - start)
	}

	timings.sort((a, b) => a - b)

	rows.push({
		name,
		scale,
		minMs: timings[0] ?? 0,
		medianMs: timings[Math.floor(timings.length / 2)] ?? 0,
		meanMs: timings.reduce((sum, value) => sum + value, 0) / Math.max(1, timings.length),
		samples: timings.length
	})
}

function formatTable(): string {
	const header = ["scenario", "scale", "min ms", "med ms", "mean ms"]
	const lines: string[][] = [header]

	for (const row of rows) {
		lines.push([row.name, String(row.scale), row.minMs.toFixed(2), row.medianMs.toFixed(2), row.meanMs.toFixed(2)])
	}

	const widths = header.map((_, col) => Math.max(...lines.map(line => (line[col] ?? "").length)))

	return lines
		.map((line, index) => {
			const text = line.map((cell, col) => (cell ?? "").padEnd(widths[col] ?? 0)).join("  ")

			return index === 0 ? `${text}\n${"-".repeat(text.length)}` : text
		})
		.join("\n")
}

describe.skipIf(!BENCH)("sort benchmark", () => {
	it("benchmarks itemSorter + notesSorter at configured scales", { timeout: 1_800_000 }, async () => {
		let coldCounter = 0

		for (const scale of SCALES) {
			// WARM fixture: fixed strings; module caches fill during the validation run
			// and stay hot for every timed sample (steady-state re-sort).
			const warmItems = buildDriveItems(scale, "warm")

			const WARM_MODES: SortByType[] = ["nameAsc", "nameDesc", "mimeAsc", "sizeAsc", "uploadDateAsc", "lastModifiedDesc", "creationDesc"]

			for (const mode of WARM_MODES) {
				await runScenario({
					name: `01 warm ${mode}`,
					scale,
					run: () => itemSorter.sortItems(warmItems, mode),
					validate: result => validateSorted(mode, warmItems, result as DriveItem[])
				})
			}

			// PRESORTED (TimSort adaptive case — refetch of an unchanged listing).
			const presortedName = itemSorter.sortItems(warmItems, "nameAsc")
			const presortedCreation = itemSorter.sortItems(warmItems, "creationDesc")

			await runScenario({
				name: "02 presorted nameAsc",
				scale,
				run: () => itemSorter.sortItems(presortedName, "nameAsc"),
				validate: result => validateSorted("nameAsc", presortedName, result as DriveItem[])
			})

			await runScenario({
				name: "02 presorted creationDesc",
				scale,
				run: () => itemSorter.sortItems(presortedCreation, "creationDesc"),
				validate: result => validateSorted("creationDesc", presortedCreation, result as DriveItem[])
			})

			// COLD: fresh strings per run → every cache misses + cache-fill overhead
			// (first visit of a big folder / photos library after boot).
			await runScenario({
				name: "03 cold nameAsc",
				scale,
				prepare: () => buildDriveItems(scale, `c${coldCounter++}n`),
				run: prepared => itemSorter.sortItems(prepared as DriveItem[], "nameAsc"),
				validate: (result, prepared) => validateSorted("nameAsc", prepared as DriveItem[], result as DriveItem[])
			})

			await runScenario({
				name: "03 cold creationDesc",
				scale,
				prepare: () => buildDriveItems(scale, `c${coldCounter++}t`),
				run: prepared => itemSorter.sortItems(prepared as DriveItem[], "creationDesc"),
				validate: (result, prepared) => validateSorted("creationDesc", prepared as DriveItem[], result as DriveItem[])
			})

			// Notes — sort() and group() (all flags + tag variant).
			const notes = buildNotes(scale, "warm")

			await runScenario({
				name: "04 notes sort",
				scale,
				run: () => notesSorter.sort(notes),
				validate: result => {
					const sorted = result as Note[]

					expect(sorted).toHaveLength(notes.length)

					for (let i = 1; i < sorted.length; i++) {
						const a = sorted[i - 1] as Note
						const b = sorted[i] as Note
						const aPinned = a.pinned ? 1 : 0
						const bPinned = b.pinned ? 1 : 0

						if (aPinned !== bPinned) {
							if (aPinned < bPinned) {
								throw new Error(`pinned order violation at ${i}`)
							}

							continue
						}

						const tier = (n: Note) => (n.trash ? 2 : n.archive ? 1 : 0)

						if (tier(a) !== tier(b)) {
							if (tier(a) > tier(b)) {
								throw new Error(`tier order violation at ${i}`)
							}

							continue
						}

						if (a.editedTimestamp !== b.editedTimestamp && Number(a.editedTimestamp) < Number(b.editedTimestamp)) {
							throw new Error(`timestamp order violation at ${i}`)
						}
					}
				}
			})

			await runScenario({
				name: "05 notes group (all flags)",
				scale,
				run: () =>
					notesSorter.group({
						notes,
						groupPinned: true,
						groupFavorited: true,
						groupArchived: true,
						groupTrashed: true
					}),
				validate: result => {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					const list = result as any[]
					const noteCount = list.filter(item => item.type === "note").length

					expect(noteCount).toBe(notes.length)
				}
			})

			await runScenario({
				name: "05 notes group (tag filter)",
				scale,
				run: () =>
					notesSorter.group({
						notes,
						tag: {
							uuid: "tag-3",
							name: "tag3",
							favorite: false,
							editedTimestamp: 1000n,
							createdTimestamp: 1000n,
							undecryptable: false
						}
					}),
				validate: result => {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					const list = result as any[]
					const noteCount = list.filter(item => item.type === "note").length
					const expected = notes.filter(note => note.tags.some(tag => tag.uuid === "tag-3")).length

					expect(noteCount).toBe(expected)
				}
			})
		}
	})

	afterAll(() => {
		if (rows.length === 0) {
			return
		}

		const table = `sort bench — samples=${SAMPLES} warmup=${WARMUP} scales=${SCALES.join(",")}\n${formatTable()}\n`

		writeFileSync(OUT_FILE, table)

		console.log(`\n${table}`)
	})
})
