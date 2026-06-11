/**
 * TEMP performance benchmark for src/lib/secureStore.ts.
 *
 * Gated behind SECURESTORE_BENCH=1. Run with:
 *
 *   SECURESTORE_BENCH=1 npx vitest run src/tests/secureStoreBench.test.ts
 *
 * Knobs (env): SECURESTORE_BENCH_SAMPLES (default 5), SECURESTORE_BENCH_WARMUP
 * (default 2), SECURESTORE_BENCH_SCALES (default "16,10000,100000" — 16 is the
 * REALISTIC production store size; the stress scales exist to expose algorithmic
 * shape), SECURESTORE_BENCH_OUT (default /tmp/secureStoreBench-out.txt).
 *
 * WORKLOAD HONESTY: production stores hold ~10–20 keys written at user-action rate.
 * The per-set whole-store copy+serialize+encrypt is the lib's DURABILITY DESIGN
 * (single encrypted blob, two-phase swap, failure leaves readCache consistent with
 * disk) — so populate-by-set is O(n²) by design and is benched at capped scales to
 * document the shape, not to "fix" it. The optimizable JS is the payload assembly
 * (copies per write), the per-op wrapper overhead, and the init fan-out loop.
 *
 * REAL in the loop: node crypto (the device boundary, constant across rounds),
 * serializer (counted passthrough), @filen/utils, events (real emitter + one
 * dummy subscriber to make emit fan-out realistic). Mock boundary: expo-file-system /
 * expo-secure-store / mmkv / quick-crypto Buffer (canonical mocks).
 */
import { describe, it, expect, afterAll, vi } from "vitest"
import { writeFileSync } from "node:fs"

const H = vi.hoisted(() => {
	// Hoisted so it lands before the (ESM-hoisted) secureStore import — its module-level
	// singleton constructor throws without the fallback key.
	process.env["EXPO_PUBLIC_SECURE_STORE_UNSECURE_FALLBACK_ENCRYPTION_KEY"] = "bench-fallback-key"

	const counters = {
		serializeCalls: 0,
		deserializeCalls: 0,
		emits: 0
	}

	return { counters }
})

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("expo-crypto", async () => await import("@/tests/mocks/expoCrypto"))

vi.mock("expo-secure-store", async () => await import("@/tests/mocks/expoSecureStore"))

vi.mock("react-native-mmkv", async () => await import("@/tests/mocks/reactNativeMMKV"))

vi.mock("react-native-quick-crypto", async () => await import("@/tests/mocks/reactNativeQuickCrypto"))

vi.mock("@/lib/cache", () => ({
	default: {
		secureStore: new Map<string, unknown>()
	}
}))

vi.mock("@/lib/events", async () => {
	const { default: EventEmitter } = await import("eventemitter3")
	const emitter = new EventEmitter()

	// One dummy subscriber per event the store emits — production has real listeners
	// (cameraUpload config watcher etc.), so emit fan-out must not be a no-op.
	let sink = 0

	emitter.on("secureStoreChange", () => {
		sink++
	})
	emitter.on("secureStoreRemove", () => {
		sink++
	})
	emitter.on("secureStoreClear", () => {
		sink++
	})

	return {
		default: {
			emit: (event: string, payload?: unknown) => {
				H.counters.emits++

				emitter.emit(event, payload)

				return sink > -1
			},
			subscribe: (event: string, listener: (payload: unknown) => void) => {
				emitter.on(event, listener)

				return {
					remove: () => {
						emitter.off(event, listener)
					}
				}
			}
		}
	}
})

vi.mock("@/constants", async () => await import("@/tests/mocks/constants"))

vi.mock("@/lib/utils", () => ({}))

vi.mock("@/lib/paths", () => ({
	normalizeFilePathForSdk: (path: string) => path
}))

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

import secureStore from "@/lib/secureStore"
import { fs } from "@/tests/mocks/expoFileSystem"
import { isAvailableAsync, getItemAsync, setItemAsync } from "@/tests/mocks/expoSecureStore"
import { mockMmkv } from "@/tests/mocks/reactNativeMMKV"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SecureStoreInstance = any

const SecureStoreCtor = secureStore.constructor as new () => SecureStoreInstance

const BENCH = process.env["SECURESTORE_BENCH"] === "1"
const SAMPLES = Number(process.env["SECURESTORE_BENCH_SAMPLES"] ?? 5)
const WARMUP = Number(process.env["SECURESTORE_BENCH_WARMUP"] ?? 2)
const SCALES = (process.env["SECURESTORE_BENCH_SCALES"] ?? "16,10000,100000")
	.split(",")
	.map(value => Number(value.trim()))
	.filter(value => Number.isFinite(value) && value > 0)
const OUT_FILE = process.env["SECURESTORE_BENCH_OUT"] ?? "/tmp/secureStoreBench-out.txt"

const FIXED_KEY_HEX = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"

type Row = {
	name: string
	scale: number
	minMs: number
	medianMs: number
	meanMs: number
	counters: Partial<typeof H.counters>
}

const rows: Row[] = []

function resetCounters(): void {
	H.counters.serializeCalls = 0
	H.counters.deserializeCalls = 0
	H.counters.emits = 0
}

function resetMocks(): void {
	fs.clear()
	isAvailableAsync.mockResolvedValue(true)
	getItemAsync.mockResolvedValue(FIXED_KEY_HEX)
	setItemAsync.mockResolvedValue(undefined)
	mockMmkv.getString.mockReturnValue(undefined)
}

function makeValue(i: number): unknown {
	return {
		enabled: i % 2 === 0,
		count: i,
		label: `entry-${i}-${String(i * 7919).padStart(8, "0")}`
	}
}

function makeRecord(n: number): Record<string, unknown> {
	const record: Record<string, unknown> = {}

	for (let i = 0; i < n; i++) {
		record[`key-${i}`] = makeValue(i)
	}

	return record
}

async function makeStoreWithRecord(record: Record<string, unknown>): Promise<SecureStoreInstance> {
	const store = new SecureStoreCtor()

	await store.init()

	// Seed via the private write path (untimed prepare): one encrypted blob on disk +
	// readCache primed — equivalent to a store that loaded this record at init.
	await store.write(record)

	return store
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

	const counters = { ...H.counters }

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
	const header = ["scenario", "scale", "min ms", "med ms", "mean ms", "ser", "deser", "emits"]
	const lines: string[][] = [header]

	for (const row of rows) {
		lines.push([
			row.name,
			String(row.scale),
			row.minMs.toFixed(2),
			row.medianMs.toFixed(2),
			row.meanMs.toFixed(2),
			String(row.counters.serializeCalls ?? 0),
			String(row.counters.deserializeCalls ?? 0),
			String(row.counters.emits ?? 0)
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

describe.skipIf(!BENCH)("secureStore benchmark", () => {
	it("benchmarks store operations at configured scales", { timeout: 1_800_000 }, async () => {
		for (const scale of SCALES) {
			const record = makeRecord(scale)
			const STEADY_SETS = 100

			// ── 01 init with n entries (decrypt + deserialize + per-key cache/emit loop) ──
			await runScenario({
				name: "01 init",
				scale,
				prepare: async () => {
					resetMocks()

					const seeder = new SecureStoreCtor()

					await seeder.init()
					await seeder.write(record)

					return new SecureStoreCtor()
				},
				run: async prepared => {
					await (prepared as SecureStoreInstance).init()
				},
				validate: async prepared => {
					expect(await (prepared as SecureStoreInstance).get("key-0")).toEqual(makeValue(0))
				}
			})

			// ── 02 set steady ×100 against an n-entry store (the realistic write shape) ──
			await runScenario({
				name: "02 set steady x100",
				scale,
				prepare: async () => {
					resetMocks()

					return await makeStoreWithRecord(record)
				},
				run: async prepared => {
					const store = prepared as SecureStoreInstance

					for (let i = 0; i < STEADY_SETS; i++) {
						await store.set("key-0", makeValue(i + 1_000_000))
					}
				},
				validate: async prepared => {
					expect(await (prepared as SecureStoreInstance).get("key-0")).toEqual(makeValue(STEADY_SETS - 1 + 1_000_000))
				}
			})

			// ── 03 get warm ×100k (readCache hit path) ─────────────────────────────────
			await runScenario({
				name: "03 get warm x100k",
				scale,
				prepare: async () => {
					resetMocks()

					return await makeStoreWithRecord(record)
				},
				run: async prepared => {
					const store = prepared as SecureStoreInstance
					let found = 0

					for (let i = 0; i < 100_000; i++) {
						const value = await store.get(`key-${i % scale}`)

						if (value !== null) {
							found++
						}
					}

					return found
				}
			})

			// ── 04 remove steady ×100 against an n-entry store (rest-spread per remove) ──
			await runScenario({
				name: "04 remove steady x100",
				scale,
				prepare: async () => {
					resetMocks()

					const store = await makeStoreWithRecord(record)

					// Add the disposable keys the timed region removes.
					const extra: Record<string, unknown> = { ...record }

					for (let i = 0; i < STEADY_SETS; i++) {
						extra[`extra-${i}`] = makeValue(i)
					}

					await store.write(extra)

					return store
				},
				run: async prepared => {
					const store = prepared as SecureStoreInstance

					for (let i = 0; i < STEADY_SETS; i++) {
						await store.remove(`extra-${i}`)
					}
				},
				validate: async prepared => {
					expect(await (prepared as SecureStoreInstance).get("extra-0")).toBeNull()
					expect(await (prepared as SecureStoreInstance).get("key-0")).toEqual(makeValue(0))
				}
			})

			// ── 05 write() payload assembly (direct, n-entry record) ───────────────────
			await runScenario({
				name: "05 write payload",
				scale,
				prepare: async () => {
					resetMocks()

					const store = new SecureStoreCtor()

					await store.init()

					return store
				},
				run: async prepared => {
					await (prepared as SecureStoreInstance).write(record)
				},
				validate: async prepared => {
					expect((prepared as SecureStoreInstance).readCache).toBe(record)
				}
			})
		}

		// ── 06 populate-by-set shape documentation (capped — O(n²) BY DESIGN) ──────────
		for (const populateScale of [16, 500]) {
			await runScenario({
				name: "06 populate by set (O(n²) by design)",
				scale: populateScale,
				prepare: async () => {
					resetMocks()

					const store = new SecureStoreCtor()

					await store.init()

					return store
				},
				run: async prepared => {
					const store = prepared as SecureStoreInstance

					for (let i = 0; i < populateScale; i++) {
						await store.set(`key-${i}`, makeValue(i))
					}
				},
				validate: async prepared => {
					expect(await (prepared as SecureStoreInstance).get(`key-${populateScale - 1}`)).toEqual(makeValue(populateScale - 1))
				}
			})
		}
	})

	afterAll(() => {
		if (rows.length === 0) {
			return
		}

		const table = `secureStore bench — samples=${SAMPLES} warmup=${WARMUP} scales=${SCALES.join(",")}\n${formatTable()}\n`

		writeFileSync(OUT_FILE, table)

		console.log(`\n${table}`)
	})
})
