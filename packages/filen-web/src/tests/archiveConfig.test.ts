import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Type } from "arktype"

const { kvStore } = vi.hoisted(() => ({ kvStore: new Map<string, unknown>() }))

// Validates against the schema like the real adapter, which collapses an invalid row to null.
vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string, schema: Type) => {
		const stored = kvStore.get(key)

		return Promise.resolve(schema.allows(stored) ? stored : null)
	},
	kvSetJson: (key: string, value: unknown) => {
		kvStore.set(key, value)

		return Promise.resolve()
	}
}))

import {
	ARCHIVE_CODEC_MEMORY_MIB,
	DEFAULT_ARCHIVE_PREFERENCES,
	buildArchiveClientConfig,
	getArchivePreferences,
	setArchivePreferences
} from "@/features/settings/lib/archiveConfig"

beforeEach(() => {
	kvStore.clear()
})

describe("buildArchiveClientConfig", () => {
	it("maps every option from MiB to bytes and sets nothing else", () => {
		for (const codecMemoryMib of ARCHIVE_CODEC_MEMORY_MIB) {
			expect(buildArchiveClientConfig({ codecMemoryMib })).toEqual({ archiveCodecMemBudget: codecMemoryMib * 1024 * 1024 })
		}
	})

	it("defaults to 128 MiB", () => {
		expect(buildArchiveClientConfig(DEFAULT_ARCHIVE_PREFERENCES)).toEqual({ archiveCodecMemBudget: 134217728 })
	})
})

describe("archive preferences: get/set", () => {
	it("returns the default when nothing is persisted", async () => {
		await expect(getArchivePreferences()).resolves.toEqual({ codecMemoryMib: 128 })
	})

	it("roundtrips every option under its own key", async () => {
		for (const codecMemoryMib of ARCHIVE_CODEC_MEMORY_MIB) {
			await setArchivePreferences({ codecMemoryMib })

			await expect(getArchivePreferences()).resolves.toEqual({ codecMemoryMib })
			expect(kvStore.get("settings.archiveConfig.v1")).toEqual({ codecMemoryMib })
		}
	})

	it("self-heals a value outside the options to the default", async () => {
		for (const stored of [{ codecMemoryMib: 100 }, { codecMemoryMib: "128" }, {}, null, "512"]) {
			kvStore.set("settings.archiveConfig.v1", stored)

			await expect(getArchivePreferences()).resolves.toEqual(DEFAULT_ARCHIVE_PREFERENCES)
		}
	})

	it("leaves the transfer preference's key alone", async () => {
		kvStore.set("settings.transferConfig.v1", { preset: "maximum" })
		await setArchivePreferences({ codecMemoryMib: 512 })

		expect(kvStore.get("settings.transferConfig.v1")).toEqual({ preset: "maximum" })
	})
})
