import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { JsClient } from "@filen/sdk-rs"
import { clientFromSession } from "../native/client.ts"
import { openEngine } from "../native/engine.ts"
import { fakeEngine, fakeSdk, sdkError } from "./nativeFakes.ts"

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

describe("clientFromSession", () => {
	it("refuses a blob that is no session, and keys the SDK cannot parse", () => {
		expect(clientFromSession(fakeSdk, "not json", "Info")).toBeNull()

		const blob = JSON.stringify({
			email: "user@example.com",
			userId: "$bigint:7n",
			rootUuid: "3f2b8c1e-6a4d-4e2f-9b7a-1c5d8e9f0a2b",
			authInfo: "a",
			privateKey: "p",
			apiKey: "k",
			authVersion: 2
		})
		const fromStringified = vi.fn(() => {
			throw sdkError(5)
		})
		const sdk = { ...fakeSdk, UnauthJsClient: { fromConfig: () => ({ fromStringified }) } } as unknown as typeof fakeSdk

		expect(clientFromSession(sdk, blob, "Debug")).toBeNull()
		expect(fromStringified).toHaveBeenCalledWith(expect.objectContaining({ userId: 7n }))
	})
})
