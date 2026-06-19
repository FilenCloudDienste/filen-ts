/**
 * TEMP performance benchmark for src/lib/cache.ts (PersistentMap + Cache).
 *
 * Gated behind CACHE_BENCH=1. Run with:
 *
 *   CACHE_BENCH=1 npx vitest run src/tests/cacheBench.test.ts
 *
 * Knobs (env): CACHE_BENCH_SAMPLES (default 5), CACHE_BENCH_WARMUP (default 2),
 * CACHE_BENCH_SCALES (default "10000,100000"), CACHE_BENCH_OUT (table file, default
 * /tmp/cacheBench-out.txt — vitest swallows console output of passing non-TTY runs).
 *
 * Methodology (mirrors the prior campaign benches): per scenario — per-sample prepare
 * OUTSIDE the timed region (fresh Cache instance, seeded state), one untimed VALIDATION
 * run asserting the kv mirror matches the live maps (the persistence correctness
 * oracle), then warmups + timed samples. Counters per ONE run: sqlite batch calls /
 * INSERT / DELETE commands (the native-hop metric), serialize() calls, and global
 * setTimeout/clearTimeout arms (the per-mutation debounce churn — es-toolkit re-arms a
 * timer on EVERY set()).
 *
 * Mock boundary: @/lib/sqlite (plain-function db over an in-memory kv Map — no vi.fn in
 * hot paths). REAL: serializer (counted passthrough), es-toolkit debounce, the Cache /
 * PersistentMap code under test. Values are realistic file-DriveItem shapes (bigint
 * fields, nested meta) so serialize cost matches production class.
 */
import { describe, it, expect, afterAll, vi } from "vitest"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))
import { writeFileSync } from "node:fs"

const H = vi.hoisted(() => {
	const counters = {
		batchCalls: 0,
		insertCmds: 0,
		deleteCmds: 0,
		clearCmds: 0,
		serializeCalls: 0,
		deserializeCalls: 0,
		timerArms: 0,
		timerClears: 0
	}

	const kvStore = new Map<string, string>()

	return { counters, kvStore }
})

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("react-native", () => ({
	AppState: {
		addEventListener: () => ({ remove: () => {} })
	},
	Platform: {
		OS: "ios",
		select(specifics: Record<string, unknown>) {
			return specifics["ios"] ?? specifics["default"]
		}
	}
}))

vi.mock("@filen/sdk-rs", () => ({
	AnyNormalDir: {
		Dir: class {
			public readonly tag = "Dir"
			public readonly inner: [unknown]
			public constructor(dir: unknown) {
				this.inner = [dir]
			}
		}
	},
	AnyDirWithContext: {
		Normal: class {
			public readonly tag = "Normal"
			public readonly inner: [unknown]
			public constructor(dir: unknown) {
				this.inner = [dir]
			}
		}
	}
}))

vi.mock("@/lib/sqlite", () => {
	const benchDb = {
		executeRaw: async (query: string, params?: (string | Uint8Array)[]) => {
			if (query.startsWith("SELECT key, value FROM kv WHERE key >= ?")) {
				const gte = params?.[0] as string
				const lt = params?.[1] as string
				const rows: [string, string][] = []

				for (const [key, value] of H.kvStore) {
					if (key >= gte && key < lt) {
						rows.push([key, value])
					}
				}

				return { rawRows: rows, columnNames: [], rowsAffected: 0 }
			}

			return { rawRows: [], columnNames: [], rowsAffected: 0 }
		},
		executeBatch: async (commands: [string, (string | Uint8Array)[]][]) => {
			H.counters.batchCalls++

			for (const [sql, params] of commands) {
				if (sql.startsWith("INSERT OR REPLACE")) {
					H.counters.insertCmds++

					H.kvStore.set(params[0] as string, params[1] as string)
				} else if (sql.includes("LIKE")) {
					H.counters.clearCmds++

					const prefix = (params[0] as string).slice(0, -1)

					for (const key of [...H.kvStore.keys()]) {
						if (key.startsWith(prefix)) {
							H.kvStore.delete(key)
						}
					}
				} else {
					H.counters.deleteCmds++

					H.kvStore.delete(params[0] as string)
				}
			}

			return { rowsAffected: commands.length }
		},
		execute: async () => ({ rows: [], insertId: undefined, rowsAffected: 0 })
	}

	return {
		default: {
			openDb: async () => benchDb,
			kvAsync: {
				removeByPrefix: async () => 0
			}
		},
		prefixUpperBound: (prefix: string) => {
			if (prefix.length === 0) {
				return prefix
			}

			const lastIndex = prefix.length - 1

			return prefix.slice(0, lastIndex) + String.fromCharCode(prefix.charCodeAt(lastIndex) + 1)
		}
	}
})

vi.mock("@/lib/serializer", async importOriginal => {
	const original = await importOriginal<typeof import("@/lib/serializer")>()

	return {
		...original,
		serialize: (value: unknown) => {
			H.counters.serializeCalls++

			return original.serialize(value)
		},
		deserialize: (value: string) => {
			H.counters.deserializeCalls++

			return original.deserialize(value)
		}
	}
})

import { Cache, GLOBAL_PREFIX } from "@/lib/cache"
import { serialize } from "@/lib/serializer"
import { type DriveItem } from "@/types"

const BENCH = process.env["CACHE_BENCH"] === "1"
const SAMPLES = Number(process.env["CACHE_BENCH_SAMPLES"] ?? 5)
const WARMUP = Number(process.env["CACHE_BENCH_WARMUP"] ?? 2)
// Explicitly typed: CI runs without the gitignored expo-env.d.ts, where process.env
// indexing degrades to `any` and the chain below trips noImplicitAny.
const SCALES_ENV: string = process.env["CACHE_BENCH_SCALES"] ?? "10000,100000"
const SCALES = SCALES_ENV.split(",")
	.map(value => Number(value.trim()))
	.filter(value => Number.isFinite(value) && value > 0)
const OUT_FILE = process.env["CACHE_BENCH_OUT"] ?? "/tmp/cacheBench-out.txt"

type CounterSnapshot = typeof H.counters

type Row = {
	name: string
	scale: number
	minMs: number
	medianMs: number
	meanMs: number
	counters: Partial<CounterSnapshot>
}

const rows: Row[] = []

function resetCounters(): void {
	H.counters.batchCalls = 0
	H.counters.insertCmds = 0
	H.counters.deleteCmds = 0
	H.counters.clearCmds = 0
	H.counters.serializeCalls = 0
	H.counters.deserializeCalls = 0
	H.counters.timerArms = 0
	H.counters.timerClears = 0
}

function snapshotCounters(): Partial<CounterSnapshot> {
	return { ...H.counters }
}

function makeUuid(i: number): string {
	return `${String(i).padStart(8, "0")}-bench-4000-8000-${String((i * 7919) % 1_000_000_000_000).padStart(12, "0")}`
}

// Realistic file-DriveItem value (bigint fields + nested meta ≈ production serialize
// cost class for uuidToAnyDriveItem).
function makeItemValue(i: number, salt: string): DriveItem {
	return {
		type: "file",
		data: {
			uuid: makeUuid(i),
			size: BigInt((i * 104729) % 10_000_000_000),
			undecryptable: false,
			decryptedMeta: {
				name: `IMG_${salt}${String(i % 9999).padStart(4, "0")}.JPG`,
				mime: "image/jpeg",
				key: "0123456789abcdef0123456789abcdef",
				created: BigInt(1_700_000_000_000 + i * 1000),
				modified: BigInt(1_700_000_000_500 + i * 1000),
				size: BigInt((i * 104729) % 10_000_000_000),
				hash: undefined
			},
			parent: `parent-${i % 50}`,
			region: "eu-west-1",
			bucket: "filen-1",
			chunks: (i % 8) + 1,
			version: 2,
			key: "",
			rm: "",
			timestamp: BigInt(1_700_000_000_000 + i * 1000),
			favorited: i % 17 === 0,
			tagged: false
		}
	} as unknown as DriveItem
}

async function makeReadyCache(): Promise<Cache> {
	const cache = new Cache()

	await cache.restore()

	return cache
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cancelPendingPersist(cache: Cache): void {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	;(cache as any).persistDirty.cancel()
}

async function runScenario({
	name,
	scale,
	prepare,
	run,
	validate
}: {
	name: string
	scale: number
	prepare: () => Promise<unknown>
	run: (prepared: unknown) => unknown | Promise<unknown>
	validate?: (prepared: unknown) => void | Promise<void>
}): Promise<void> {
	// Validation run (untimed) with counter snapshot.
	let prepared = await prepare()

	resetCounters()

	await run(prepared)

	const counters = snapshotCounters()

	if (validate) {
		await validate(prepared)
	}

	for (let i = 0; i < WARMUP; i++) {
		prepared = await prepare()

		await run(prepared)
	}

	const timings: number[] = []

	for (let i = 0; i < SAMPLES; i++) {
		prepared = await prepare()

		const start = performance.now()

		await run(prepared)

		timings.push(performance.now() - start)
	}

	timings.sort((a, b) => a - b)

	rows.push({
		name,
		scale,
		minMs: timings[0] ?? 0,
		medianMs: timings[Math.floor(timings.length / 2)] ?? 0,
		meanMs: timings.reduce((sum, value) => sum + value, 0) / Math.max(1, timings.length),
		counters
	})
}

function formatTable(): string {
	const header = ["scenario", "scale", "min ms", "med ms", "mean ms", "batch", "INS", "DEL", "ser", "deser", "tArm", "tClr"]
	const lines: string[][] = [header]

	for (const row of rows) {
		lines.push([
			row.name,
			String(row.scale),
			row.minMs.toFixed(2),
			row.medianMs.toFixed(2),
			row.meanMs.toFixed(2),
			String(row.counters.batchCalls ?? 0),
			String(row.counters.insertCmds ?? 0),
			String(row.counters.deleteCmds ?? 0),
			String(row.counters.serializeCalls ?? 0),
			String(row.counters.deserializeCalls ?? 0),
			String(row.counters.timerArms ?? 0),
			String(row.counters.timerClears ?? 0)
		])
	}

	const widths = header.map((_, col) => Math.max(...lines.map(line => (line[col] ?? "").length)))

	return lines
		.map((line, index) => {
			const text = line.map((cell, col) => (cell ?? "").padEnd(widths[col] ?? 0)).join("  ")

			return index === 0 ? `${text}\n${"-".repeat(text.length)}` : text
		})
		.join("\n")
}

describe.skipIf(!BENCH)("cache benchmark", () => {
	it("benchmarks PersistentMap + Cache persistence at configured scales", { timeout: 1_800_000 }, async () => {
		// Count timer churn (the per-mutation debounce re-arm cost) for the whole bench.
		const realSetTimeout = globalThis.setTimeout
		const realClearTimeout = globalThis.clearTimeout

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		;(globalThis as any).setTimeout = (...args: Parameters<typeof setTimeout>) => {
			H.counters.timerArms++

			return realSetTimeout(...args)
		}

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		;(globalThis as any).clearTimeout = (...args: Parameters<typeof clearTimeout>) => {
			H.counters.timerClears++

			return realClearTimeout(...args)
		}

		try {
			for (const scale of SCALES) {
				const freshValues: DriveItem[] = new Array(scale)
				const equalValues: DriveItem[] = new Array(scale)
				const changedValues: DriveItem[] = new Array(scale)
				const uuids: string[] = new Array(scale)

				for (let i = 0; i < scale; i++) {
					freshValues[i] = makeItemValue(i, "a")
					equalValues[i] = makeItemValue(i, "a")
					changedValues[i] = makeItemValue(i, "b")
					uuids[i] = makeUuid(i)
				}

				// ── 01 set fresh ×n (mutation path incl. dirty-marking + debounce churn) ──
				await runScenario({
					name: "01 set fresh",
					scale,
					prepare: async () => {
						H.kvStore.clear()

						return await makeReadyCache()
					},
					run: prepared => {
						const cache = prepared as Cache

						for (let i = 0; i < scale; i++) {
							cache.uuidToAnyDriveItem.set(uuids[i] as string, freshValues[i] as DriveItem)
						}

						cancelPendingPersist(cache)
					},
					validate: prepared => {
						expect((prepared as Cache).uuidToAnyDriveItem.size).toBe(scale)
					}
				})

				// ── 02 set same-ref ×n (reference-dedup fast path) ────────────────────
				await runScenario({
					name: "02 set same-ref",
					scale,
					prepare: async () => {
						H.kvStore.clear()

						const cache = await makeReadyCache()

						for (let i = 0; i < scale; i++) {
							cache.uuidToAnyDriveItem.set(uuids[i] as string, freshValues[i] as DriveItem)
						}

						cancelPendingPersist(cache)

						return cache
					},
					run: prepared => {
						const cache = prepared as Cache

						for (let i = 0; i < scale; i++) {
							cache.uuidToAnyDriveItem.set(uuids[i] as string, freshValues[i] as DriveItem)
						}

						cancelPendingPersist(cache)
					}
				})

				// ── 03 set equal-fresh ×n (the refetch reality: same content, new refs) ──
				await runScenario({
					name: "03 set equal-fresh",
					scale,
					prepare: async () => {
						H.kvStore.clear()

						const cache = await makeReadyCache()

						for (let i = 0; i < scale; i++) {
							cache.uuidToAnyDriveItem.set(uuids[i] as string, freshValues[i] as DriveItem)
						}

						cancelPendingPersist(cache)

						return cache
					},
					run: prepared => {
						const cache = prepared as Cache

						for (let i = 0; i < scale; i++) {
							cache.uuidToAnyDriveItem.set(uuids[i] as string, equalValues[i] as DriveItem)
						}

						cancelPendingPersist(cache)
					}
				})

				// ── 04 flushNow after fresh populate (n real INSERTs) ─────────────────
				await runScenario({
					name: "04 flush fresh",
					scale,
					prepare: async () => {
						H.kvStore.clear()

						const cache = await makeReadyCache()

						for (let i = 0; i < scale; i++) {
							cache.uuidToAnyDriveItem.set(uuids[i] as string, freshValues[i] as DriveItem)
						}

						return cache
					},
					run: async prepared => {
						await (prepared as Cache).flushNow()
					},
					validate: async prepared => {
						const cache = prepared as Cache

						expect(H.kvStore.size).toBe(scale)

						const sampleKey = `${GLOBAL_PREFIX}:uuidToAnyDriveItem:${uuids[0] as string}`

						expect(H.kvStore.get(sampleKey)).toBe(serialize(cache.uuidToAnyDriveItem.get(uuids[0] as string)))
					}
				})

				// ── 05 flush after equal-fresh re-set (refetch steady state) ──────────
				// THE headline: today this issues n redundant INSERTs for zero logical change.
				await runScenario({
					name: "05 flush equal-fresh",
					scale,
					prepare: async () => {
						H.kvStore.clear()

						const cache = await makeReadyCache()

						for (let i = 0; i < scale; i++) {
							cache.uuidToAnyDriveItem.set(uuids[i] as string, freshValues[i] as DriveItem)
						}

						await cache.flushNow()

						for (let i = 0; i < scale; i++) {
							cache.uuidToAnyDriveItem.set(uuids[i] as string, equalValues[i] as DriveItem)
						}

						return cache
					},
					run: async prepared => {
						await (prepared as Cache).flushNow()
					},
					validate: prepared => {
						const cache = prepared as Cache

						// State-equality oracle: kv mirrors the live map whether or not
						// redundant INSERTs were issued.
						expect(H.kvStore.size).toBe(scale)

						for (let i = 0; i < scale; i += Math.max(1, Math.floor(scale / 97))) {
							const key = `${GLOBAL_PREFIX}:uuidToAnyDriveItem:${uuids[i] as string}`

							expect(H.kvStore.get(key)).toBe(serialize(cache.uuidToAnyDriveItem.get(uuids[i] as string)))
						}
					}
				})

				// ── 06 restore n rows ──────────────────────────────────────────────────
				await runScenario({
					name: "06 restore",
					scale,
					prepare: async () => {
						H.kvStore.clear()

						const prefix = `${GLOBAL_PREFIX}:uuidToAnyDriveItem:`

						for (let i = 0; i < scale; i++) {
							H.kvStore.set(prefix + (uuids[i] as string), serialize(freshValues[i]))
						}

						return new Cache()
					},
					run: async prepared => {
						await (prepared as Cache).restore()
					},
					validate: prepared => {
						expect((prepared as Cache).uuidToAnyDriveItem.size).toBe(scale)
					}
				})

				// ── 07 delete ×n + flush ───────────────────────────────────────────────
				await runScenario({
					name: "07 delete + flush",
					scale,
					prepare: async () => {
						H.kvStore.clear()

						const cache = await makeReadyCache()

						for (let i = 0; i < scale; i++) {
							cache.uuidToAnyDriveItem.set(uuids[i] as string, freshValues[i] as DriveItem)
						}

						await cache.flushNow()

						return cache
					},
					run: async prepared => {
						const cache = prepared as Cache

						for (let i = 0; i < scale; i++) {
							cache.uuidToAnyDriveItem.delete(uuids[i] as string)
						}

						await cache.flushNow()
					},
					validate: () => {
						expect(H.kvStore.size).toBe(0)
					}
				})

				// ── 08 mixed churn + flush (60% equal-fresh / 20% changed / 20% delete) ──
				await runScenario({
					name: "08 mixed churn + flush",
					scale,
					prepare: async () => {
						H.kvStore.clear()

						const cache = await makeReadyCache()

						for (let i = 0; i < scale; i++) {
							cache.uuidToAnyDriveItem.set(uuids[i] as string, freshValues[i] as DriveItem)
						}

						await cache.flushNow()

						return cache
					},
					run: async prepared => {
						const cache = prepared as Cache

						for (let i = 0; i < scale; i++) {
							const bucket = i % 10

							if (bucket < 6) {
								cache.uuidToAnyDriveItem.set(uuids[i] as string, equalValues[i] as DriveItem)
							} else if (bucket < 8) {
								cache.uuidToAnyDriveItem.set(uuids[i] as string, changedValues[i] as DriveItem)
							} else {
								cache.uuidToAnyDriveItem.delete(uuids[i] as string)
							}
						}

						await cache.flushNow()
					},
					validate: prepared => {
						const cache = prepared as Cache

						expect(H.kvStore.size).toBe(cache.uuidToAnyDriveItem.size)

						for (let i = 0; i < scale; i += Math.max(1, Math.floor(scale / 97))) {
							const key = `${GLOBAL_PREFIX}:uuidToAnyDriveItem:${uuids[i] as string}`
							const live = cache.uuidToAnyDriveItem.get(uuids[i] as string)

							if (live === undefined) {
								expect(H.kvStore.has(key)).toBe(false)
							} else {
								expect(H.kvStore.get(key)).toBe(serialize(live))
							}
						}
					}
				})

				// ── 09 forgetItem ×n (7 map deletes per call) ──────────────────────────
				await runScenario({
					name: "09 forgetItem",
					scale,
					prepare: async () => {
						H.kvStore.clear()

						const cache = await makeReadyCache()

						for (let i = 0; i < scale; i++) {
							cache.uuidToAnyDriveItem.set(uuids[i] as string, freshValues[i] as DriveItem)

							if (i % 2 === 0) {
								cache.directoryUuidToName.set(uuids[i] as string, `dir-${i}`)
							}
						}

						cancelPendingPersist(cache)

						return cache
					},
					run: prepared => {
						const cache = prepared as Cache

						for (let i = 0; i < scale; i++) {
							cache.forgetItem(uuids[i] as string)
						}

						cancelPendingPersist(cache)
					},
					validate: prepared => {
						expect((prepared as Cache).uuidToAnyDriveItem.size).toBe(0)
					}
				})

				// ── 10 clear() in-memory wipe ──────────────────────────────────────────
				await runScenario({
					name: "10 clear",
					scale,
					prepare: async () => {
						H.kvStore.clear()

						const cache = await makeReadyCache()

						for (let i = 0; i < scale; i++) {
							cache.uuidToAnyDriveItem.set(uuids[i] as string, freshValues[i] as DriveItem)
						}

						cancelPendingPersist(cache)

						return cache
					},
					run: prepared => {
						;(prepared as Cache).clear()
					},
					validate: prepared => {
						expect((prepared as Cache).uuidToAnyDriveItem.size).toBe(0)
					}
				})
			}
		} finally {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			;(globalThis as any).setTimeout = realSetTimeout

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			;(globalThis as any).clearTimeout = realClearTimeout
		}
	})

	afterAll(() => {
		if (rows.length === 0) {
			return
		}

		const table = `cache bench — samples=${SAMPLES} warmup=${WARMUP} scales=${SCALES.join(",")}\n${formatTable()}\n`

		writeFileSync(OUT_FILE, table)

		console.log(`\n${table}`)
	})
})
