import { vi, describe, it, expect } from "vitest"
import pathModule from "path"

// @ts-expect-error __DEV__ is a React Native global
globalThis.__DEV__ = true

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("@/lib/paths", () => ({
	normalizeFilePathForSdk: (filePath: string): string => {
		let normalizedPath = filePath
			.trim()
			.replace(/^file:\/+/, "/")
			.split("/")
			.map(segment => (segment.length > 0 ? decodeURIComponent(segment) : segment))
			.join("/")

		if (!normalizedPath.startsWith("/")) {
			normalizedPath = "/" + normalizedPath
		}

		if (normalizedPath.endsWith("/") && normalizedPath !== "/") {
			normalizedPath = normalizedPath.slice(0, -1)
		}

		return pathModule.posix.normalize(normalizedPath)
	},
	normalizeFilePathForExpo: (p: string) => p
}))

import {
	modifyAssetPathOnCollision,
	sanitizePathSegment,
	applyAfterActivationToggle,
	type CollisionParams
} from "@/features/cameraUpload/cameraUploadHelpers"

// ─── sanitizePathSegment ──────────────────────────────────────────────────────

describe("sanitizePathSegment", () => {
	it("replaces all forward slashes with underscores", () => {
		expect(sanitizePathSegment("A1B2C3/L0/020")).toBe("A1B2C3_L0_020")
	})

	it("replaces a single slash", () => {
		expect(sanitizePathSegment("foo/bar")).toBe("foo_bar")
	})

	it("returns an empty string unchanged", () => {
		expect(sanitizePathSegment("")).toBe("")
	})

	it("leaves a segment with no slashes unchanged", () => {
		expect(sanitizePathSegment("Screenshots")).toBe("Screenshots")
	})

	it("replaces multiple consecutive slashes", () => {
		expect(sanitizePathSegment("a//b///c")).toBe("a__b___c")
	})

	it("replaces a leading slash", () => {
		expect(sanitizePathSegment("/leading")).toBe("_leading")
	})

	it("replaces a trailing slash", () => {
		expect(sanitizePathSegment("trailing/")).toBe("trailing_")
	})
})

// ─── modifyAssetPathOnCollision ──────────────────────────────────────────────

// Helper with sensible defaults; the caller always supplies iteration.
function collision(overrides: Partial<CollisionParams> & { iteration: number }): string | null {
	const { iteration, ...rest } = overrides

	return modifyAssetPathOnCollision({
		path: "/camera roll/img_0001.jpg",
		asset: {
			name: "IMG_0001.jpg",
			contentHash: "abc123hash"
		},
		...rest,
		iteration
	})
}

describe("modifyAssetPathOnCollision", () => {
	describe("iteration 0 — seconds-timestamp suffix", () => {
		it("appends contentHash (seconds-timestamp string) to the basename and returns lowercase trimmed path", () => {
			// The contentHash field carries a seconds-floored creation timestamp string.
			expect(collision({ iteration: 0 })).toBe("/camera roll/img_0001_abc123hash.jpg")
		})

		it("produces different paths for different contentHashes", () => {
			const a = collision({ iteration: 0, asset: { name: "IMG_0001.jpg", contentHash: "hash-a" } })
			const b = collision({ iteration: 0, asset: { name: "IMG_0001.jpg", contentHash: "hash-b" } })

			expect(a).not.toBe(b)
		})

		it("result is lowercased", () => {
			const result = collision({
				iteration: 0,
				path: "/Camera Roll/IMG_0001.JPG",
				asset: { name: "IMG_0001.JPG", contentHash: "SomeHash" }
			})

			expect(result).toBe(result?.toLowerCase())
		})

		it("preserves the file extension from the asset name", () => {
			const result = collision({
				iteration: 0,
				path: "/album/video.mov",
				asset: { name: "video.MOV", contentHash: "hash1" }
			})

			expect(result).toMatch(/\.mov$/)
		})
	})

	describe("iteration 1 — xxHash32 of name + contentHash", () => {
		it("returns a valid path with a lowercase hex hash suffix", () => {
			expect(collision({ iteration: 1 })).toMatch(/^\/camera roll\/img_0001_[0-9a-f]+\.jpg$/)
		})

		it("produces different paths for different contentHashes", () => {
			const a = collision({ iteration: 1, asset: { name: "IMG_0001.jpg", contentHash: "hash-a" } })
			const b = collision({ iteration: 1, asset: { name: "IMG_0001.jpg", contentHash: "hash-b" } })

			expect(a).not.toBe(b)
		})

		it("produces different paths for different filenames with the same contentHash", () => {
			const a = modifyAssetPathOnCollision({
				iteration: 1,
				path: "/album/img_0001.jpg",
				asset: { name: "IMG_0001.jpg", contentHash: "same-hash" }
			})
			const b = modifyAssetPathOnCollision({
				iteration: 1,
				path: "/album/img_0002.jpg",
				asset: { name: "IMG_0002.jpg", contentHash: "same-hash" }
			})

			expect(a).not.toBe(b)
		})

		it("iteration 0 and iteration 1 produce distinct paths for the same inputs", () => {
			const path0 = collision({ iteration: 0 })
			const path1 = collision({ iteration: 1 })

			expect(path0).not.toBe(path1)
		})
	})

	describe("exhausted iterations — returns null", () => {
		it("returns null at iteration 2 (first unsupported value)", () => {
			// The default case returns null for any iteration >= 2.
			expect(collision({ iteration: 2 })).toBeNull()
		})

		it("returns null for iteration 3", () => {
			expect(collision({ iteration: 3 })).toBeNull()
		})

		it("returns null for a large iteration number", () => {
			expect(collision({ iteration: 100 })).toBeNull()
		})
	})

	describe("invalid / degenerate paths", () => {
		it("returns null when asset name basename resolves to '.'", () => {
			// The null guard triggers when basename === ".".
			expect(
				modifyAssetPathOnCollision({
					iteration: 0,
					path: "/camera roll/.",
					asset: { name: ".", contentHash: "hash1" }
				})
			).toBeNull()
		})

		it("returns a non-null string when path has no parent directory prefix (mock Paths.dirname falls back to DOCUMENT_URI, not '.')", () => {
			// The mock Paths.dirname for bare filenames returns "file:///document", not ".",
			// so the null guard does NOT trigger and the function returns a valid path string.
			const result = modifyAssetPathOnCollision({
				iteration: 0,
				path: "IMG_0001.jpg",
				asset: { name: "IMG_0001.jpg", contentHash: "hash1" }
			})

			expect(result).toBeTypeOf("string")
			expect(result).not.toBeNull()
		})
	})

	describe("determinism", () => {
		it("returns the same result on repeated calls with identical inputs (iteration 0)", () => {
			const params: CollisionParams = {
				iteration: 0,
				path: "/album/photo.png",
				asset: { name: "photo.png", contentHash: "hash1" }
			}

			expect(modifyAssetPathOnCollision(params)).toBe(modifyAssetPathOnCollision(params))
		})

		it("returns the same result on repeated calls with identical inputs (iteration 1)", () => {
			const params: CollisionParams = {
				iteration: 1,
				path: "/album/photo.png",
				asset: { name: "photo.png", contentHash: "hash1" }
			}

			expect(modifyAssetPathOnCollision(params)).toBe(modifyAssetPathOnCollision(params))
		})
	})

	describe("collision resolution loop — current behaviour", () => {
		it("iteration 0 → non-null, iteration 1 → non-null, iteration 2 → null (exhausted after 2 suffixes)", () => {
			const base: Omit<CollisionParams, "iteration"> = {
				path: "/album/img_0001.jpg",
				asset: { name: "IMG_0001.jpg", contentHash: "hash1" }
			}

			// Exactly two non-null iterations before exhaustion.
			expect(modifyAssetPathOnCollision({ ...base, iteration: 0 })).not.toBeNull()
			expect(modifyAssetPathOnCollision({ ...base, iteration: 1 })).not.toBeNull()
			expect(modifyAssetPathOnCollision({ ...base, iteration: 2 })).toBeNull()
		})

		it("the two non-null iterations produce distinct paths so a loop can allocate two extra slots", () => {
			const base: Omit<CollisionParams, "iteration"> = {
				path: "/album/img_0001.jpg",
				asset: { name: "IMG_0001.jpg", contentHash: "hash1" }
			}

			const path0 = modifyAssetPathOnCollision({ ...base, iteration: 0 })
			const path1 = modifyAssetPathOnCollision({ ...base, iteration: 1 })

			expect(path0).not.toBe(path1)
		})
	})

	describe("seconds-timestamp dedup (#14 regression)", () => {
		it("two same-named assets at different creation seconds get different collision paths at iteration 0", () => {
			// Two IMG_0001.jpg assets created 1 second apart must get different paths.
			const a = modifyAssetPathOnCollision({
				iteration: 0,
				path: "/camera roll/img_0001.jpg",
				asset: { name: "IMG_0001.jpg", contentHash: String(Math.floor(1700000000000 / 1000)) }
			})
			const b = modifyAssetPathOnCollision({
				iteration: 0,
				path: "/camera roll/img_0001.jpg",
				asset: { name: "IMG_0001.jpg", contentHash: String(Math.floor(1700000001000 / 1000)) }
			})

			expect(a).not.toBe(b)
		})

		it("two same-named assets within the same second collapse to the same path (sub-second drift — deduped by design)", () => {
			// 700ms and 200ms within the same second both floor to "1700000000".
			const tsA = String(Math.floor(1700000000700 / 1000)) // "1700000000"
			const tsB = String(Math.floor(1700000000200 / 1000)) // "1700000000"

			const a = modifyAssetPathOnCollision({
				iteration: 0,
				path: "/camera roll/img_0001.jpg",
				asset: { name: "IMG_0001.jpg", contentHash: tsA }
			})
			const b = modifyAssetPathOnCollision({
				iteration: 0,
				path: "/camera roll/img_0001.jpg",
				asset: { name: "IMG_0001.jpg", contentHash: tsB }
			})

			expect(a).toBe(b)
			expect(a).toBe("/camera roll/img_0001_1700000000.jpg")
		})

		it("local and remote sides produce symmetric paths when both use seconds-floored timestamps", () => {
			// Local: String(Math.floor((creationTime ?? 0) / 1000))
			// Remote: String(Math.floor(Number(meta?.created ?? 0) / 1000))
			// Both must produce the same string for the same wall-clock second.
			const localMs = 1700000000700
			const remoteMs = 1700000000200 // same second, 500ms earlier

			const localHash = String(Math.floor(localMs / 1000))
			const remoteHash = String(Math.floor(remoteMs / 1000))

			const localPath = modifyAssetPathOnCollision({
				iteration: 0,
				path: "/camera roll/img_0001.jpg",
				asset: { name: "IMG_0001.jpg", contentHash: localHash }
			})
			const remotePath = modifyAssetPathOnCollision({
				iteration: 0,
				path: "/camera roll/img_0001.jpg",
				asset: { name: "IMG_0001.jpg", contentHash: remoteHash }
			})

			expect(localPath).toBe(remotePath)
			expect(localPath).toBe("/camera roll/img_0001_1700000000.jpg")
		})

		it("null creationTime falls back to '0' on both local and remote sides symmetrically", () => {
			// Local: Math.floor((null ?? 0) / 1000) = 0
			// Remote: Math.floor(Number(null ?? 0) / 1000) = 0
			// Both produce contentHash "0" — paths are symmetric.
			const nullCreationTime: number | null = null
			const nullCreated: bigint | null | undefined = null

			const localHash = String(Math.floor((nullCreationTime ?? 0) / 1000))
			const remoteHash = String(Math.floor(Number(nullCreated ?? 0) / 1000))

			expect(localHash).toBe("0")
			expect(remoteHash).toBe("0")

			const local = modifyAssetPathOnCollision({
				iteration: 0,
				path: "/camera roll/img_0001.jpg",
				asset: { name: "IMG_0001.jpg", contentHash: localHash }
			})
			const remote = modifyAssetPathOnCollision({
				iteration: 0,
				path: "/camera roll/img_0001.jpg",
				asset: { name: "IMG_0001.jpg", contentHash: remoteHash }
			})

			expect(local).toBe(remote)
		})
	})
})

// ─── applyAfterActivationToggle ──────────────────────────────────────────────

describe("applyAfterActivationToggle", () => {
	const baseConfig = {
		afterActivation: false,
		activationTimestamp: 0,
		enabled: true
	}

	it("stamps activationTimestamp with `now` when enabling (false → true)", () => {
		const result = applyAfterActivationToggle({
			config: baseConfig,
			enabled: true,
			now: 1700000000000
		})

		expect(result.afterActivation).toBe(true)
		expect(result.activationTimestamp).toBe(1700000000000)
	})

	it("resets activationTimestamp to 0 when disabling (true → false)", () => {
		const result = applyAfterActivationToggle({
			config: {
				afterActivation: true,
				activationTimestamp: 1700000000000,
				enabled: true
			},
			enabled: false,
			now: 1800000000000
		})

		expect(result.afterActivation).toBe(false)
		expect(result.activationTimestamp).toBe(0)
	})

	it("ignores `now` when disabling — timestamp is always 0, never the injected value", () => {
		const result = applyAfterActivationToggle({
			config: baseConfig,
			enabled: false,
			now: 1800000000000
		})

		expect(result.activationTimestamp).toBe(0)
	})

	it("preserves unrelated config fields", () => {
		const result = applyAfterActivationToggle({
			config: baseConfig,
			enabled: true,
			now: 1234
		})

		expect(result.enabled).toBe(true)
	})

	it("does not mutate the input config", () => {
		const config = {
			afterActivation: false,
			activationTimestamp: 0,
			enabled: true
		}

		applyAfterActivationToggle({
			config,
			enabled: true,
			now: 1234
		})

		expect(config.afterActivation).toBe(false)
		expect(config.activationTimestamp).toBe(0)
	})

	it("is deterministic for the same injected `now`", () => {
		const a = applyAfterActivationToggle({ config: baseConfig, enabled: true, now: 555 })
		const b = applyAfterActivationToggle({ config: baseConfig, enabled: true, now: 555 })

		expect(a).toEqual(b)
	})
})
