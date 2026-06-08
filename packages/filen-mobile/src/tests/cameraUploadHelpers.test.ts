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
			creationTime: 1700000000000
		},
		...rest,
		iteration
	})
}

describe("modifyAssetPathOnCollision", () => {
	describe("iteration 0 — creationTime suffix", () => {
		it("appends creationTime to the basename and returns lowercase trimmed path", () => {
			// Current behaviour: path gets the creationTime appended before the extension.
			expect(collision({ iteration: 0 })).toBe("/camera roll/img_0001_1700000000000.jpg")
		})

		it("produces different paths for different creationTimes", () => {
			const a = collision({ iteration: 0, asset: { name: "IMG_0001.jpg", creationTime: 1000 } })
			const b = collision({ iteration: 0, asset: { name: "IMG_0001.jpg", creationTime: 5000 } })

			expect(a).not.toBe(b)
		})

		it("result is lowercased", () => {
			const result = collision({
				iteration: 0,
				path: "/Camera Roll/IMG_0001.JPG",
				asset: { name: "IMG_0001.JPG", creationTime: 1000 }
			})

			expect(result).toBe(result?.toLowerCase())
		})

		it("preserves the file extension from the asset name", () => {
			const result = collision({
				iteration: 0,
				path: "/album/video.mov",
				asset: { name: "video.MOV", creationTime: 1000 }
			})

			expect(result).toMatch(/\.mov$/)
		})
	})

	describe("iteration 1 — hash of name + creationTime", () => {
		it("returns a valid path with a lowercase hex hash suffix", () => {
			expect(collision({ iteration: 1 })).toMatch(/^\/camera roll\/img_0001_[0-9a-f]+\.jpg$/)
		})

		it("produces different paths for different creationTimes", () => {
			const a = collision({ iteration: 1, asset: { name: "IMG_0001.jpg", creationTime: 1000 } })
			const b = collision({ iteration: 1, asset: { name: "IMG_0001.jpg", creationTime: 2000 } })

			expect(a).not.toBe(b)
		})

		it("produces different paths for different filenames with the same creationTime", () => {
			const a = modifyAssetPathOnCollision({
				iteration: 1,
				path: "/album/img_0001.jpg",
				asset: { name: "IMG_0001.jpg", creationTime: 1000 }
			})
			const b = modifyAssetPathOnCollision({
				iteration: 1,
				path: "/album/img_0002.jpg",
				asset: { name: "IMG_0002.jpg", creationTime: 1000 }
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
			// Current behaviour: the default case returns null for any iteration >= 2.
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
					asset: { name: ".", creationTime: 1000 }
				})
			).toBeNull()
		})

		it("returns a non-null string when path has no parent directory prefix (mock Paths.dirname falls back to DOCUMENT_URI, not '.')", () => {
			// The mock Paths.dirname for bare filenames returns "file:///document", not ".",
			// so the null guard does NOT trigger and the function returns a valid path string.
			const result = modifyAssetPathOnCollision({
				iteration: 0,
				path: "IMG_0001.jpg",
				asset: { name: "IMG_0001.jpg", creationTime: 1000 }
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
				asset: { name: "photo.png", creationTime: 1000 }
			}

			expect(modifyAssetPathOnCollision(params)).toBe(modifyAssetPathOnCollision(params))
		})

		it("returns the same result on repeated calls with identical inputs (iteration 1)", () => {
			const params: CollisionParams = {
				iteration: 1,
				path: "/album/photo.png",
				asset: { name: "photo.png", creationTime: 1000 }
			}

			expect(modifyAssetPathOnCollision(params)).toBe(modifyAssetPathOnCollision(params))
		})
	})

	describe("collision resolution loop — current behaviour", () => {
		it("iteration 0 → non-null, iteration 1 → non-null, iteration 2 → null (exhausted after 2 suffixes)", () => {
			const base: Omit<CollisionParams, "iteration"> = {
				path: "/album/img_0001.jpg",
				asset: { name: "IMG_0001.jpg", creationTime: 1000 }
			}

			// Exactly two non-null iterations before exhaustion.
			expect(modifyAssetPathOnCollision({ ...base, iteration: 0 })).not.toBeNull()
			expect(modifyAssetPathOnCollision({ ...base, iteration: 1 })).not.toBeNull()
			expect(modifyAssetPathOnCollision({ ...base, iteration: 2 })).toBeNull()
		})

		it("the two non-null iterations produce distinct paths so a loop can allocate two extra slots", () => {
			const base: Omit<CollisionParams, "iteration"> = {
				path: "/album/img_0001.jpg",
				asset: { name: "IMG_0001.jpg", creationTime: 1000 }
			}

			const path0 = modifyAssetPathOnCollision({ ...base, iteration: 0 })
			const path1 = modifyAssetPathOnCollision({ ...base, iteration: 1 })

			expect(path0).not.toBe(path1)
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
