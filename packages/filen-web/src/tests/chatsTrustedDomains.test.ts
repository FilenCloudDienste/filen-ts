import { beforeEach, describe, expect, it, vi } from "vitest"

// Same mock boundary/shape as sidebarWidth.test.ts: `@/lib/storage/adapter` itself, backed by an
// in-memory Map reset per test.
const { kvStore } = vi.hoisted(() => ({ kvStore: new Map<string, unknown>() }))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(kvStore.get(key) ?? null),
	kvSetJson: (key: string, value: unknown) => {
		kvStore.set(key, value)

		return Promise.resolve()
	}
}))

import { getTrustedDomains, trustDomain } from "@/features/chats/lib/trustedDomains"

beforeEach(() => {
	kvStore.clear()
})

describe("trusted domains: get/trust", () => {
	it("is empty when nothing is persisted", async () => {
		await expect(getTrustedDomains()).resolves.toEqual(new Set())
	})

	it("roundtrips a trusted domain", async () => {
		await trustDomain("example.com")

		await expect(getTrustedDomains()).resolves.toEqual(new Set(["example.com"]))
	})

	it("accumulates multiple distinct domains across separate confirmations", async () => {
		await trustDomain("example.com")
		await trustDomain("other.example")

		await expect(getTrustedDomains()).resolves.toEqual(new Set(["example.com", "other.example"]))
	})

	it("is idempotent — trusting an already-trusted domain again doesn't duplicate it", async () => {
		await trustDomain("example.com")
		await trustDomain("example.com")

		const stored = await getTrustedDomains()
		expect(stored.size).toBe(1)
	})
})
