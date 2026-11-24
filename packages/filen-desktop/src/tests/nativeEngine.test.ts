import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { JsClient } from "@filen/sdk-rs"
import { clientsFromSession } from "../native/client.ts"
import { openEngine } from "../native/engine.ts"
import { fakeEngine, fakeSdk, sdkError, SPEED } from "./nativeFakes.ts"

const listeners = { cache: { onMessages: () => undefined }, sync: { onEvents: () => undefined, onWatchStatus: () => undefined } }

let dir: string

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "filen-native-"))
})

afterEach(() => {
	rmSync(dir, { recursive: true, force: true })
})

function fakeClient(open: () => Promise<unknown>) {
	const order: string[] = []
	const client = {
		configureCache: vi.fn((cachePath: string) => {
			order.push(`cache ${path.basename(cachePath)}`)

			return Promise.resolve()
		}),
		openSyncEngine: vi.fn((dbPath: string) => {
			order.push(`open ${path.basename(dbPath)}`)

			return open()
		})
	}

	return { client, handle: client as unknown as JsClient, order }
}

const mismatch = () =>
	sdkError(fakeSdk.ErrorKind.InvalidState, "schema", {
		tag: "BaselineSchemaMismatch",
		inner: { path: path.join(dir, "baseline.db"), found: 1000n, expected: 3n }
	})

describe("openEngine", () => {
	it("configures the cache before opening", async () => {
		const { engine } = fakeEngine()
		const { handle, order } = fakeClient(() => Promise.resolve(engine))

		await expect(openEngine(fakeSdk, handle, dir, listeners)).resolves.toEqual({ engine, reset: false })
		expect(order).toEqual(["cache cache.db", "open baseline.db"])
	})

	it("schema mismatch resets", async () => {
		for (const file of ["baseline.db", "baseline.db-wal", "baseline.db-shm", "cache.db"]) {
			writeFileSync(path.join(dir, file), "x")
		}

		const { engine } = fakeEngine()
		let opens = 0
		const { client, handle } = fakeClient(() => (opens++ === 0 ? Promise.reject(mismatch()) : Promise.resolve(engine)))

		await expect(openEngine(fakeSdk, handle, dir, listeners)).resolves.toEqual({ engine, reset: true })
		expect(client.openSyncEngine).toHaveBeenCalledTimes(2)
		expect(["baseline.db", "baseline.db-wal", "baseline.db-shm"].some(file => existsSync(path.join(dir, file)))).toBe(false)
		expect(existsSync(path.join(dir, "cache.db"))).toBe(true)
	})

	it("gives up when the new baseline is refused too", async () => {
		const { client, handle } = fakeClient(() => Promise.reject(mismatch()))

		await expect(openEngine(fakeSdk, handle, dir, listeners)).resolves.toMatchObject({ fatal: "open" })
		expect(client.openSyncEngine).toHaveBeenCalledTimes(2)
	})

	it("baseline in use is fatal", async () => {
		writeFileSync(path.join(dir, "baseline.db"), "x")

		const inUse = sdkError(fakeSdk.ErrorKind.Io, "in use", { tag: "BaselineInUse", inner: { path: path.join(dir, "baseline.db") } })
		const { client, handle } = fakeClient(() => Promise.reject(inUse))

		await expect(openEngine(fakeSdk, handle, dir, listeners)).resolves.toMatchObject({ fatal: "baselineInUse" })
		expect(client.openSyncEngine).toHaveBeenCalledTimes(1)
		expect(existsSync(path.join(dir, "baseline.db"))).toBe(true)
	})
})

describe("clientsFromSession", () => {
	const blob = JSON.stringify({
		email: "user@example.com",
		userId: "$bigint:7n",
		rootUuid: "3f2b8c1e-6a4d-4e2f-9b7a-1c5d8e9f0a2b",
		authInfo: "a",
		privateKey: "p",
		apiKey: "k",
		authVersion: 2
	})

	it("refuses a blob that is no session, and keys the SDK cannot parse", () => {
		expect(clientsFromSession(fakeSdk, "not json", "Info", SPEED)).toBeNull()

		const fromStringified = vi.fn(() => {
			throw sdkError(5)
		})
		const sdk = { ...fakeSdk, UnauthJsClient: { fromConfig: () => ({ fromStringified }) } } as unknown as typeof fakeSdk

		expect(clientsFromSession(sdk, blob, "Debug", SPEED)).toBeNull()
		expect(fromStringified).toHaveBeenCalledWith(expect.objectContaining({ userId: 7n }))
	})

	// One UnauthJsClient's clients share its limiters and budget: each client needs its own.
	it("builds each client from its own fromConfig call, with its own speed", () => {
		const built: { config: unknown; client: object }[] = []
		const fromConfig = vi.fn((config: unknown) => ({
			fromStringified: () => {
				const client = {}

				built.push({ config, client })

				return client
			}
		}))
		const sdk = { ...fakeSdk, UnauthJsClient: { fromConfig } } as unknown as typeof fakeSdk
		const clients = clientsFromSession(sdk, blob, "Info", {
			sync: { preset: "batterySaver", uploadKbps: 0, downloadKbps: 0 },
			transfers: { preset: "performance", uploadKbps: 4, downloadKbps: 900 }
		})

		expect(fromConfig).toHaveBeenCalledTimes(2)
		expect(built.map(entry => entry.config)).toEqual([
			{
				logLevel: fakeSdk.LogLevel.Info,
				concurrency: 12,
				rateLimitPerSec: 64,
				fileIoMemoryBudget: BigInt(8 * 1_048_604),
				uploadBandwidthKilobytesPerSec: 0,
				downloadBandwidthKilobytesPerSec: 0
			},
			{
				logLevel: fakeSdk.LogLevel.Info,
				concurrency: 96,
				rateLimitPerSec: 320,
				fileIoMemoryBudget: BigInt(64 * 1_048_604),
				// The SDK refuses an upload limit under 16 KB/s at construction.
				uploadBandwidthKilobytesPerSec: 16,
				downloadBandwidthKilobytesPerSec: 900
			}
		])
		expect(clients?.sync).toBe(built[0]?.client)
		expect(clients?.transfers).toBe(built[1]?.client)
		expect(clients?.sync).not.toBe(clients?.transfers)
	})
})
