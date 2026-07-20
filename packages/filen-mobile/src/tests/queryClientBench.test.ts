/**
 * TEMP performance benchmark for src/queries/client.ts (QueryPersisterKv +
 * restoreQueries + queryUpdater + shouldPersistQuery).
 *
 * Gated behind QUERY_BENCH=1. Run with:
 *
 *   QUERY_BENCH=1 npx vitest run src/tests/queryClientBench.test.ts
 *
 * Knobs (env): QUERY_BENCH_SAMPLES (default 5), QUERY_BENCH_WARMUP (default 2),
 * QUERY_BENCH_SCALES (default "10000,100000"), QUERY_BENCH_OUT (table file, default
 * /tmp/queryClientBench-out.txt).
 *
 * Methodology: per scenario — per-sample prepare OUTSIDE the timed region, one untimed
 * VALIDATION run with state-equality oracles (kv mirrors buffer; queryClient holds the
 * restored data), then warmups + timed samples. Counters per ONE run: sqlite batch /
 * INSERT / DELETE commands, serialize/deserialize calls, global setTimeout/clearTimeout
 * arms (the per-mutation debounce churn).
 *
 * REAL in the loop: @tanstack/react-query + query-persist-client-core (their cost is
 * constant across rounds — our machinery's deltas are what the counters isolate),
 * es-toolkit, @filen/utils, the serializer (counted passthrough). Mocked boundary:
 * @/lib/sqlite (plain-function db over an in-memory kv Map).
 *
 * Fixture axes: many-small entries at 10k/100k (per-entry machinery), plus a
 * listing-blob variant (1k queries × 100-item DriveItem arrays — the realistic
 * persisted-query shape, serializer-passthrough heavy).
 */
import { describe, it, expect, afterAll, vi } from "vitest"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))
import { writeFileSync } from "node:fs"

const H = vi.hoisted(() => {
	const counters = {
		batchCalls: 0,
		insertCmds: 0,
		deleteCmds: 0,
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
		addEventListener: () => ({ remove: () => {} }),
		currentState: "active"
	},
	Platform: {
		OS: "ios",
		select: <T,>(specifics: { ios?: T; android?: T; default?: T }) => specifics["ios"] ?? specifics["default"]
	}
}))

vi.mock("@/lib/sqlite", async () => {
	const { isKvRangeScanQuery, kvRangeScanRows } = await import("@/tests/mocks/kvExecuteRaw")

	const benchDb = {
		executeRaw: async (query: string, params?: (string | Uint8Array)[]) => {
			if (isKvRangeScanQuery(query)) {
				return { rawRows: kvRangeScanRows(H.kvStore, query, params), columnNames: [], rowsAffected: 0 }
			}

			return { rawRows: [], columnNames: [], rowsAffected: 0 }
		},
		executeBatch: async (commands: [string, (string | Uint8Array)[]][]) => {
			H.counters.batchCalls++

			for (const [sql, params] of commands) {
				if (sql.startsWith("INSERT OR REPLACE")) {
					H.counters.insertCmds++

					H.kvStore.set(params[0] as string, params[1] as string)
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
			// Mirror the real contract: an empty or U+FFFF-terminated prefix has no valid exclusive
			// upper bound, so the real function throws — the fake must too, or it could drift.
			const lastIndex = prefix.length - 1

			if (prefix.length === 0 || prefix.charCodeAt(lastIndex) === 0xffff) {
				throw new Error("prefixUpperBound: prefix must be non-empty and must not end in U+FFFF")
			}

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

vi.mock("@/lib/sdkErrors", () => ({
	unwrapSdkError: () => null,
	isNetworkClassError: () => false
}))

vi.mock("@filen/sdk-rs", () => ({
	ErrorKind: { Unauthenticated: "Unauthenticated" }
}))

vi.mock("@/lib/alerts", () => ({
	default: {
		error: () => {},
		normal: () => {}
	}
}))

vi.mock("@/lib/auth", () => ({
	default: {
		logout: async () => undefined
	}
}))

vi.mock("@/stores/useApp.store", () => ({
	default: {
		getState: () => ({ biometricUnlocked: true })
	}
}))

import {
	QueryPersisterKv,
	queryClientPersisterKv,
	queryClient,
	queryUpdater,
	restoreQueries,
	shouldPersistQuery,
	QUERY_CLIENT_PERSISTER_PREFIX
} from "@/queries/client"
import { serialize } from "@/lib/serializer"
import { type PersistedQuery } from "@tanstack/query-persist-client-core"

const BENCH = process.env["QUERY_BENCH"] === "1"
const SAMPLES = Number(process.env["QUERY_BENCH_SAMPLES"] ?? 5)
const WARMUP = Number(process.env["QUERY_BENCH_WARMUP"] ?? 2)
// Explicitly typed: CI runs without the gitignored expo-env.d.ts, where process.env
// indexing degrades to `any` and the chain below trips noImplicitAny.
const SCALES_ENV: string = process.env["QUERY_BENCH_SCALES"] ?? "10000,100000"
const SCALES = SCALES_ENV.split(",")
	.map(value => Number(value.trim()))
	.filter(value => Number.isFinite(value) && value > 0)
const OUT_FILE = process.env["QUERY_BENCH_OUT"] ?? "/tmp/queryClientBench-out.txt"

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
	H.counters.serializeCalls = 0
	H.counters.deserializeCalls = 0
	H.counters.timerArms = 0
	H.counters.timerClears = 0
}

function snapshotCounters(): Partial<CounterSnapshot> {
	return { ...H.counters }
}

function makeItem(i: number) {
	return {
		type: "file",
		data: {
			uuid: `${String(i).padStart(8, "0")}-q-4000-8000-000000000000`,
			size: BigInt((i * 104729) % 10_000_000_000),
			name: `IMG_${String(i % 9999).padStart(4, "0")}.JPG`,
			modified: BigInt(1_700_000_000_500 + i * 1000)
		}
	}
}

function makePersistedQuery(i: number, itemCount: number): PersistedQuery {
	const data = new Array(itemCount)

	for (let j = 0; j < itemCount; j++) {
		data[j] = makeItem(i * 1000 + j)
	}

	return {
		queryKey: ["useDriveItemsQuery", { path: { type: "drive", uuid: `parent-${i}` } }],
		queryHash: "",
		buster: "1",
		state: {
			data,
			dataUpdateCount: 1,
			dataUpdatedAt: 1_750_000_000_000 + i,
			error: null,
			errorUpdateCount: 0,
			errorUpdatedAt: 0,
			fetchFailureCount: 0,
			fetchFailureReason: null,
			fetchMeta: null,
			isInvalidated: false,
			status: "success",
			fetchStatus: "idle"
		}
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} as unknown as PersistedQuery
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cancelPendingPersist(persister: QueryPersisterKv): void {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	;(persister as any).persistDirty.cancel()
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resetDirtySets(persister: QueryPersisterKv): void {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	;(persister as any).dirtyUpserts.clear()
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	;(persister as any).dirtyDeletes.clear()
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	;(persister as any).buffer.clear()
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
	prepare: () => Promise<unknown> | unknown
	run: (prepared: unknown) => unknown | Promise<unknown>
	validate?: (prepared: unknown) => void | Promise<void>
}): Promise<void> {
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

describe.skipIf(!BENCH)("query client benchmark", () => {
	it("benchmarks QueryPersisterKv + restoreQueries + queryUpdater at configured scales", { timeout: 1_800_000 }, async () => {
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
				const smallValues: PersistedQuery[] = new Array(scale)
				const keys: string[] = new Array(scale)

				for (let i = 0; i < scale; i++) {
					smallValues[i] = makePersistedQuery(i, 1)
					keys[i] = `key-${i}`
				}

				// ── 01 setItem fresh ×n ────────────────────────────────────────────────
				await runScenario({
					name: "01 setItem fresh",
					scale,
					prepare: () => {
						H.kvStore.clear()

						return new QueryPersisterKv()
					},
					run: prepared => {
						const persister = prepared as QueryPersisterKv

						for (let i = 0; i < scale; i++) {
							persister.setItem(keys[i] as string, smallValues[i])
						}

						cancelPendingPersist(persister)
					},
					validate: prepared => {
						expect((prepared as QueryPersisterKv).keys()).toHaveLength(scale)
					}
				})

				// ── 02 removeItem ×n ───────────────────────────────────────────────────
				await runScenario({
					name: "02 removeItem",
					scale,
					prepare: () => {
						H.kvStore.clear()

						const persister = new QueryPersisterKv()

						for (let i = 0; i < scale; i++) {
							persister.setItem(keys[i] as string, smallValues[i])
						}

						cancelPendingPersist(persister)
						resetDirtySets(persister)

						for (let i = 0; i < scale; i++) {
							persister.setItem(keys[i] as string, smallValues[i])
						}

						cancelPendingPersist(persister)

						return persister
					},
					run: prepared => {
						const persister = prepared as QueryPersisterKv

						for (let i = 0; i < scale; i++) {
							persister.removeItem(keys[i] as string)
						}

						cancelPendingPersist(persister)
					}
				})

				// ── 03 flushNow after populate (n INSERTs) ─────────────────────────────
				await runScenario({
					name: "03 flushNow populate",
					scale,
					prepare: () => {
						H.kvStore.clear()

						const persister = new QueryPersisterKv()

						for (let i = 0; i < scale; i++) {
							persister.setItem(keys[i] as string, smallValues[i])
						}

						return persister
					},
					run: async prepared => {
						const persister = prepared as QueryPersisterKv

						persister.flushNow()

						// flushNow is fire-and-forget by contract — settle the write.
						for (let i = 0; i < 50 && H.counters.batchCalls === 0; i++) {
							await Promise.resolve()
						}
					},
					validate: () => {
						expect(H.kvStore.size).toBe(scale)

						const sample = H.kvStore.get(`${QUERY_CLIENT_PERSISTER_PREFIX}:key-0`)

						expect(sample).toBe(serialize(smallValues[0]))
					}
				})

				// ── 04 restore() n rows ────────────────────────────────────────────────
				await runScenario({
					name: "04 restore",
					scale,
					prepare: () => {
						H.kvStore.clear()

						for (let i = 0; i < scale; i++) {
							H.kvStore.set(`${QUERY_CLIENT_PERSISTER_PREFIX}:key-${i}`, serialize(smallValues[i]))
						}

						return new QueryPersisterKv()
					},
					run: async prepared => {
						await (prepared as QueryPersisterKv).restore()
					},
					validate: prepared => {
						expect((prepared as QueryPersisterKv).keys()).toHaveLength(scale)
					}
				})

				// ── 05 restoreQueries() e2e (module singletons, REAL TanStack) ─────────
				// 10% of rows are droppable (expired) so the gate+removeItem path runs.
				await runScenario({
					name: "05 restoreQueries e2e",
					scale,
					prepare: async () => {
						H.kvStore.clear()
						queryClient.clear()
						resetDirtySets(queryClientPersisterKv)

						for (let i = 0; i < scale; i++) {
							const query = makePersistedQuery(i, 1)

							if (i % 10 === 0) {
								// eslint-disable-next-line @typescript-eslint/no-explicit-any
								;(query.state as any).dataUpdatedAt = 1
							}

							queryClientPersisterKv.setItem(keys[i] as string, query)
						}

						cancelPendingPersist(queryClientPersisterKv)
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						;(queryClientPersisterKv as any).dirtyUpserts.clear()
					},
					run: async () => {
						await restoreQueries()

						cancelPendingPersist(queryClientPersisterKv)
					},
					validate: () => {
						const sampleKey = (smallValues[1] as PersistedQuery).queryKey

						expect(queryClient.getQueryData(sampleKey)).toBeDefined()
						expect(queryClientPersisterKv.keys()).toHaveLength(scale - Math.ceil(scale / 10))
					}
				})

				// ── 06 queryUpdater.set ×n (REAL TanStack setQueryData + persister) ────
				const updaterScale = Math.min(scale, 20_000)

				await runScenario({
					name: "06 queryUpdater.set",
					scale: updaterScale,
					prepare: () => {
						queryClient.clear()
						resetDirtySets(queryClientPersisterKv)
						H.kvStore.clear()
					},
					run: async () => {
						for (let i = 0; i < updaterScale; i++) {
							queryUpdater.set(["bench-updater", i], { value: i })
						}

						// Drain the per-call async persist chains.
						for (let i = 0; i < 60; i++) {
							await Promise.resolve()
						}

						cancelPendingPersist(queryClientPersisterKv)
					},
					validate: () => {
						expect(queryClient.getQueryData(["bench-updater", 0])).toEqual({ value: 0 })
					}
				})

				// ── 07 shouldPersistQuery micro ×2n ────────────────────────────────────
				const flatQuery = makePersistedQuery(1, 1)
				const nestedQuery = {
					...flatQuery,
					queryKey: ["outer", ["useFileTextQuery", "inner"], { x: 1 }]
				} as unknown as PersistedQuery

				await runScenario({
					name: "07 shouldPersistQuery",
					scale,
					prepare: () => undefined,
					run: () => {
						let acc = 0

						for (let i = 0; i < scale; i++) {
							acc += shouldPersistQuery(flatQuery) ? 1 : 0
							acc += shouldPersistQuery(nestedQuery) ? 1 : 0
						}

						return acc
					},
					validate: () => {
						expect(shouldPersistQuery(flatQuery)).toBe(true)
						expect(shouldPersistQuery(nestedQuery)).toBe(false)
					}
				})
			}

			// ── 08 listing-blob axis: 1k queries × 100 items ──────────────────────────
			const blobCount = 1000
			const blobs: PersistedQuery[] = new Array(blobCount)

			for (let i = 0; i < blobCount; i++) {
				blobs[i] = makePersistedQuery(i, 100)
			}

			await runScenario({
				name: "08 flushNow 1k listing-blobs",
				scale: blobCount,
				prepare: () => {
					H.kvStore.clear()

					const persister = new QueryPersisterKv()

					for (let i = 0; i < blobCount; i++) {
						persister.setItem(`blob-${i}`, blobs[i])
					}

					return persister
				},
				run: async prepared => {
					const persister = prepared as QueryPersisterKv

					persister.flushNow()

					for (let i = 0; i < 50 && H.counters.batchCalls === 0; i++) {
						await Promise.resolve()
					}
				},
				validate: () => {
					expect(H.kvStore.size).toBe(blobCount)
				}
			})

			await runScenario({
				name: "08 restore 1k listing-blobs",
				scale: blobCount,
				prepare: () => {
					H.kvStore.clear()

					for (let i = 0; i < blobCount; i++) {
						H.kvStore.set(`${QUERY_CLIENT_PERSISTER_PREFIX}:blob-${i}`, serialize(blobs[i]))
					}

					return new QueryPersisterKv()
				},
				run: async prepared => {
					await (prepared as QueryPersisterKv).restore()
				},
				validate: prepared => {
					expect((prepared as QueryPersisterKv).keys()).toHaveLength(blobCount)
				}
			})
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

		const table = `query client bench — samples=${SAMPLES} warmup=${WARMUP} scales=${SCALES.join(",")}\n${formatTable()}\n`

		writeFileSync(OUT_FILE, table)

		console.log(`\n${table}`)
	})
})
