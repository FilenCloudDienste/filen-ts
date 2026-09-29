import { beforeEach, describe, expect, it, vi } from "vitest"
import { type } from "arktype"
import { kvLoadOnce, kvSetJsonQuiet } from "@/lib/storage/kvBestEffort"

const { kvGetJson, kvSetJson, warn } = vi.hoisted(() => ({
	kvGetJson: vi.fn(),
	kvSetJson: vi.fn(),
	warn: vi.fn()
}))

vi.mock("@/lib/storage/adapter", () => ({ kvGetJson, kvSetJson }))
vi.mock("@/lib/log", () => ({ log: { warn } }))

const schema = type({ n: "number" })

beforeEach(() => {
	kvGetJson.mockReset()
	kvSetJson.mockReset()
	warn.mockReset()
})

describe("kvLoadOnce", () => {
	it("reads once per loader and applies a stored value", async () => {
		kvGetJson.mockResolvedValue({ n: 1 })
		const apply = vi.fn()
		const load = kvLoadOnce("k", schema, apply, "test", "thing")

		await Promise.all([load(), load()])
		await load()

		expect(kvGetJson).toHaveBeenCalledTimes(1)
		expect(apply).toHaveBeenCalledExactlyOnceWith({ n: 1 })
	})

	it("skips apply when nothing is stored", async () => {
		kvGetJson.mockResolvedValue(null)
		const apply = vi.fn()

		await kvLoadOnce("k", schema, apply, "test", "thing")()

		expect(apply).not.toHaveBeenCalled()
	})

	it("logs and swallows a failed read", async () => {
		const error = new Error("down")
		kvGetJson.mockRejectedValue(error)
		const apply = vi.fn()

		await expect(kvLoadOnce("k", schema, apply, "test", "thing")()).resolves.toBeUndefined()

		expect(apply).not.toHaveBeenCalled()
		expect(warn).toHaveBeenCalledWith("test", "failed to load persisted thing", error)
	})
})

describe("kvSetJsonQuiet", () => {
	it("writes the value", async () => {
		kvSetJson.mockResolvedValue(undefined)

		await kvSetJsonQuiet("k", { n: 2 }, "test", "thing")

		expect(kvSetJson).toHaveBeenCalledWith("k", { n: 2 })
		expect(warn).not.toHaveBeenCalled()
	})

	it("logs and swallows a failed write", async () => {
		const error = new Error("full")
		kvSetJson.mockRejectedValue(error)

		await expect(kvSetJsonQuiet("k", { n: 2 }, "test", "thing")).resolves.toBeUndefined()

		expect(warn).toHaveBeenCalledWith("test", "failed to persist thing", error)
	})
})
