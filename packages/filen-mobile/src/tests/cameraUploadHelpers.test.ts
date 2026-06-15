import { vi, describe, it, expect } from "vitest"
import pathModule from "path"

// @ts-expect-error __DEV__ is a React Native global
globalThis.__DEV__ = true

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

// isDirUsable delegates the trash check to isTrashParent (real impl reads
// parent.tag === ParentUuid_Tags.Trash). Stub @/lib/sdkUnwrap directly so the
// helpers test stays light (the real module pulls the whole SDK + cache).
vi.mock("@/lib/sdkUnwrap", () => ({
	isTrashParent: (parent: { tag?: string } | null | undefined) => parent?.tag === "Trash"
}))

// type-only import of Dir from @filen/sdk-rs is erased at runtime, but the module
// graph still resolves it — stub it to avoid pulling the native SDK into this test.
vi.mock("@filen/sdk-rs", () => ({}))

import {
	modifyAssetPathOnCollision,
	collisionNameSuffix,
	sanitizePathSegment,
	albumFolderTitle,
	applyAfterActivationToggle,
	dedupTreeKey,
	stripFilenameExtension,
	effectiveCreationTimestamp,
	composeLocalTreePath,
	rawRemoteTreePath,
	normalizeCameraUploadHashEntry,
	isDirUsable,
	CAMERA_UPLOAD_REUPLOAD_DELETED_SECURE_STORE_KEY,
	type CollisionParams
} from "@/features/cameraUpload/cameraUploadHelpers"

// The PREVIOUS dedup-key pipeline (normalizeFilePathForSdk ∘ Paths.join), replicated
// verbatim so compatibility tests can prove the raw composition produces byte-identical
// keys for every name WITHOUT decodable %XX sequences. The real expo Paths.join
// percent-ENCODES its rest args and normalizeFilePathForSdk percent-DECODES segments —
// for plain names the two cancel out; for names with literal well-formed %XX they
// corrupt the key (the bug #E2 removes).
function oldNormalizeFilePathForSdk(filePath: string): string {
	let normalizedPath = filePath
		.trim()
		.replace(/^file:\/+/, "/")
		.split("/")
		.map(segment => {
			if (segment.length === 0) {
				return segment
			}

			try {
				return decodeURIComponent(segment)
			} catch {
				return segment
			}
		})
		.join("/")

	if (!normalizedPath.startsWith("/")) {
		normalizedPath = "/" + normalizedPath
	}

	if (normalizedPath.endsWith("/") && normalizedPath !== "/") {
		normalizedPath = normalizedPath.slice(0, -1)
	}

	return pathModule.posix.normalize(normalizedPath)
}

// ─── composeLocalTreePath / rawRemoteTreePath (#E2 raw dedup keys) ───────────

describe("composeLocalTreePath", () => {
	it("plain names: byte-identical to the previous join+normalize pipeline's output", () => {
		// For names without decodable %XX the old pipeline was an identity round-trip
		// (join percent-encoded, normalize percent-decoded). The raw composition must
		// produce the exact same key so existing md5-cache entries keep matching.
		const composed = composeLocalTreePath({ folderTitle: "Camera Roll", filename: "IMG_0001.jpg" })

		expect(composed).toBe("/Camera Roll/IMG_0001.jpg")
		expect(composed).toBe(oldNormalizeFilePathForSdk("Camera Roll/IMG_0001.jpg"))
		expect(composed.toLowerCase()).toBe("/camera roll/img_0001.jpg")
	})

	it("preserves a literal %20 in a filename (no percent-decoding)", () => {
		const composed = composeLocalTreePath({ folderTitle: "Camera Roll", filename: "photo %20 test.jpg" })

		expect(composed).toBe("/Camera Roll/photo %20 test.jpg")
		// The OLD pipeline corrupted this exact class of name (decode turned the
		// literal "%20" into a space), making local and remote keys diverge forever.
		expect(oldNormalizeFilePathForSdk("/Camera Roll/photo %20 test.jpg")).toBe("/Camera Roll/photo   test.jpg")
	})

	it("a literal %2F in a filename never gains a phantom path separator", () => {
		const composed = composeLocalTreePath({ folderTitle: "Camera Roll", filename: "a%2Fb.jpg" })

		expect(composed).toBe("/Camera Roll/a%2Fb.jpg")
		// Exactly two separators: leading + between folder and filename.
		expect(composed.split("/").length - 1).toBe(2)
		// The OLD pipeline decoded %2F into "/", splitting the filename into a
		// phantom extra segment.
		expect(oldNormalizeFilePathForSdk("/Camera Roll/a%2Fb.jpg")).toBe("/Camera Roll/a/b.jpg")
	})

	it("trims outer whitespace like the old pipeline did", () => {
		expect(composeLocalTreePath({ folderTitle: "Camera Roll", filename: "photo.jpg " })).toBe("/Camera Roll/photo.jpg")
	})
})

describe("rawRemoteTreePath", () => {
	it("returns the raw path verbatim (already-leading-slash case)", () => {
		expect(rawRemoteTreePath("/Camera Roll/photo.jpg")).toBe("/Camera Roll/photo.jpg")
	})

	it("ensures a leading slash without touching the segments", () => {
		expect(rawRemoteTreePath("Camera Roll/photo.jpg")).toBe("/Camera Roll/photo.jpg")
	})

	it("never percent-decodes: literal %20 and %2F stay literal", () => {
		expect(rawRemoteTreePath("/Camera Roll/photo %20 test.jpg")).toBe("/Camera Roll/photo %20 test.jpg")
		expect(rawRemoteTreePath("/Camera Roll/a%2Fb.jpg")).toBe("/Camera Roll/a%2Fb.jpg")
	})

	it("local and remote keys are identical for the same raw name (lowercased comparison)", () => {
		for (const filename of ["IMG_0001.jpg", "photo %20 test.jpg", "a%2Fb.jpg", "Invoice 50%.pdf"]) {
			const local = composeLocalTreePath({ folderTitle: "Camera Roll", filename }).toLowerCase()
			const remote = rawRemoteTreePath(`/Camera Roll/${filename}`).toLowerCase()

			expect(local).toBe(remote)
		}
	})
})

// ─── effectiveCreationTimestamp (#B7 ONE timestamp rule) ─────────────────────

describe("effectiveCreationTimestamp", () => {
	it("returns creationTime when present", () => {
		expect(effectiveCreationTimestamp({ creationTime: 1700000000000, modificationTime: 1800000000000 })).toBe(1700000000000)
	})

	it("falls back to modificationTime when creationTime is null", () => {
		expect(effectiveCreationTimestamp({ creationTime: null, modificationTime: 1800000000000 })).toBe(1800000000000)
	})

	it("falls back to 0 when both are null", () => {
		expect(effectiveCreationTimestamp({ creationTime: null, modificationTime: null })).toBe(0)
	})

	it("creationTime 0 is a valid epoch timestamp, NOT a fallback trigger", () => {
		expect(effectiveCreationTimestamp({ creationTime: 0, modificationTime: 1800000000000 })).toBe(0)
	})

	it("modificationTime 0 is a valid epoch fallback for null creationTime", () => {
		expect(effectiveCreationTimestamp({ creationTime: null, modificationTime: 0 })).toBe(0)
	})
})

// ─── collisionNameSuffix (#B2) ───────────────────────────────────────────────

describe("collisionNameSuffix", () => {
	it("iteration 0 appends the contentHash directly", () => {
		expect(collisionNameSuffix({ iteration: 0, asset: { name: "IMG_0001.jpg", contentHash: "1700000000" } })).toBe("_1700000000")
	})

	it("iteration 1 appends the xxHash32 hex of name + contentHash", () => {
		expect(collisionNameSuffix({ iteration: 1, asset: { name: "IMG_0001.jpg", contentHash: "1700000000" } })).toMatch(/^_[0-9a-f]+$/)
	})

	it("returns null for iteration >= 2 (exhausted)", () => {
		expect(collisionNameSuffix({ iteration: 2, asset: { name: "IMG_0001.jpg", contentHash: "1" } })).toBeNull()
	})

	it("the suffix is exactly what modifyAssetPathOnCollision embeds into the path", () => {
		for (const iteration of [0, 1]) {
			const asset = { name: "IMG_0001.jpg", contentHash: "1700000000" }
			const suffix = collisionNameSuffix({ iteration, asset })
			const path = modifyAssetPathOnCollision({ iteration, path: "/camera roll/img_0001.jpg", asset })

			expect(suffix).not.toBeNull()
			expect(path).toBe(`/camera roll/img_0001${suffix}.jpg`)
		}
	})

	it("suffixes contain only filename-safe characters (no sanitization needed)", () => {
		for (const iteration of [0, 1]) {
			const suffix = collisionNameSuffix({ iteration, asset: { name: "IMG_0001.jpg", contentHash: "1700000000" } })

			expect(suffix).toMatch(/^_[a-z0-9_-]+$/)
		}
	})
})

// ─── normalizeCameraUploadHashEntry (#B4+B6 lazy migration) ──────────────────

describe("normalizeCameraUploadHashEntry", () => {
	it("undefined passes through", () => {
		expect(normalizeCameraUploadHashEntry(undefined)).toBeUndefined()
	})

	it("a legacy string value becomes { md5, verifiedModificationTime: -1 }", () => {
		expect(normalizeCameraUploadHashEntry("abc123")).toEqual({
			md5: "abc123",
			verifiedModificationTime: -1
		})
	})

	it("an object value passes through unchanged (same reference)", () => {
		const entry = { md5: "abc123", verifiedModificationTime: 1700000000000 }

		expect(normalizeCameraUploadHashEntry(entry)).toBe(entry)
	})
})

describe("CAMERA_UPLOAD_REUPLOAD_DELETED_SECURE_STORE_KEY", () => {
	it("is a stable secureStore key (persisted setting — never rename)", () => {
		expect(CAMERA_UPLOAD_REUPLOAD_DELETED_SECURE_STORE_KEY).toBe("cameraUploadReuploadDeleted")
	})
})

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

// ─── albumFolderTitle (merge scheme: folder = trimmed title; dups share a folder) ──

describe("albumFolderTitle", () => {
	it("returns a normal album title unchanged", () => {
		expect(albumFolderTitle("Screenshots")).toBe("Screenshots")
	})

	it("preserves casing (no lowercasing) so the folder round-trips with the remote key", () => {
		expect(albumFolderTitle("Camera Roll")).toBe("Camera Roll")
	})

	it("trims leading and trailing whitespace", () => {
		expect(albumFolderTitle("  Vacation  ")).toBe("Vacation")
	})

	it("preserves inner whitespace", () => {
		expect(albumFolderTitle("Family Trip 2024")).toBe("Family Trip 2024")
	})

	it("replaces forward slashes with underscores (path-segment safety)", () => {
		expect(albumFolderTitle("Trips/2024")).toBe("Trips_2024")
	})

	it("never leaves a forward slash in the result", () => {
		for (const title of ["a/b", "/leading", "trailing/", "a//b///c", " x/y "]) {
			expect(albumFolderTitle(title)).not.toContain("/")
		}
	})

	it("returns null for an empty title", () => {
		expect(albumFolderTitle("")).toBeNull()
	})

	it("returns null for a whitespace-only title (caller must skip it)", () => {
		expect(albumFolderTitle("   ")).toBeNull()
	})

	it("a slash-only title is non-empty after trim and sanitizes to underscores (not skipped)", () => {
		expect(albumFolderTitle("/")).toBe("_")
	})

	it("preserves unicode / emoji titles verbatim", () => {
		expect(albumFolderTitle("Sommer ☀️ 2024")).toBe("Sommer ☀️ 2024")
	})

	it("MERGE: two different albums with the same title resolve to the same folder", () => {
		// The core of the merge scheme — the name depends only on the title, never the
		// album id, so same-titled albums deliberately share one server folder.
		expect(albumFolderTitle("Camera Roll")).toBe(albumFolderTitle("Camera Roll"))
		expect(albumFolderTitle("Camera Roll")).toBe("Camera Roll")
	})

	it("MERGE: titles differing only by surrounding whitespace also share a folder", () => {
		expect(albumFolderTitle(" Camera Roll ")).toBe(albumFolderTitle("Camera Roll"))
	})

	it("preserves case — does not lowercase the title (the remote handles case-insensitive merging)", () => {
		expect(albumFolderTitle("Trip")).not.toBe(albumFolderTitle("trip"))
	})

	it("is deterministic for the same title", () => {
		expect(albumFolderTitle("Screenshots")).toBe(albumFolderTitle("Screenshots"))
	})

	it("composes into a clean single-folder tree path", () => {
		const folderTitle = albumFolderTitle("Camera Roll")

		expect(folderTitle).not.toBeNull()

		if (folderTitle !== null) {
			const path = composeLocalTreePath({ folderTitle, filename: "IMG_0001.jpg" })

			expect(path).toBe("/Camera Roll/IMG_0001.jpg")
			expect(path.split("/").length - 1).toBe(2)
		}
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

		it("returns null when the path has no parent directory prefix", () => {
			// #E2: the parent is now extracted with plain string ops (no Paths.dirname),
			// so a bare filename — which can never be a valid tree key (keys are always
			// "/<album>/<name>") — deterministically returns null on every platform
			// instead of depending on dirname fallback behavior.
			const result = modifyAssetPathOnCollision({
				iteration: 0,
				path: "IMG_0001.jpg",
				asset: { name: "IMG_0001.jpg", contentHash: "hash1" }
			})

			expect(result).toBeNull()
		})

		it("a root-level path keeps resolving under '/' (no double slash)", () => {
			const result = modifyAssetPathOnCollision({
				iteration: 0,
				path: "/img_0001.jpg",
				asset: { name: "IMG_0001.jpg", contentHash: "hash1" }
			})

			expect(result).toBe("/img_0001_hash1.jpg")
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

// ─── dedupTreeKey + stripFilenameExtension (#15 regression) ───────────────────

describe("stripFilenameExtension", () => {
	it("strips a trailing extension", () => {
		expect(stripFilenameExtension("photo.png")).toBe("photo")
	})

	it("strips only the LAST extension on multi-dot names", () => {
		expect(stripFilenameExtension("archive.tar.gz")).toBe("archive.tar")
	})

	it("returns the name unchanged when there is no extension", () => {
		expect(stripFilenameExtension("README")).toBe("README")
	})

	it("returns an empty string unchanged", () => {
		expect(stripFilenameExtension("")).toBe("")
	})

	it("collapses .png and .jpg of the same stem to the same value", () => {
		expect(stripFilenameExtension("photo.png")).toBe(stripFilenameExtension("photo.jpg"))
	})
})

describe("dedupTreeKey", () => {
	it("returns the full path verbatim when compress is OFF (extension preserved)", () => {
		expect(dedupTreeKey({ path: "/camera roll/photo.png", compress: false })).toBe("/camera roll/photo.png")
	})

	it("strips the extension when compress is ON (extension-agnostic key)", () => {
		expect(dedupTreeKey({ path: "/camera roll/photo.png", compress: true })).toBe("/camera roll/photo")
	})

	it("compress ON: .png and .jpg of the same stem collapse to one key (#15 symmetry)", () => {
		// Local lists the source .png; remote (after compression won) lists .jpg.
		// Both must dedup to the identical key or the asset re-uploads every sync.
		const local = dedupTreeKey({ path: "/camera roll/photo.png", compress: true })
		const remote = dedupTreeKey({ path: "/camera roll/photo.jpg", compress: true })

		expect(local).toBe(remote)
		expect(local).toBe("/camera roll/photo")
	})

	it("compress ON: .png and .jpg of the same stem do NOT collapse when compress is OFF", () => {
		// With compress off the upload never renames, so different extensions are
		// genuinely different files and must stay distinct.
		const png = dedupTreeKey({ path: "/camera roll/photo.png", compress: false })
		const jpg = dedupTreeKey({ path: "/camera roll/photo.jpg", compress: false })

		expect(png).not.toBe(jpg)
	})

	it("compress ON: a path with no extension is returned unchanged", () => {
		expect(dedupTreeKey({ path: "/camera roll/photo", compress: true })).toBe("/camera roll/photo")
	})

	it("compress ON: distinct stems stay distinct", () => {
		const a = dedupTreeKey({ path: "/camera roll/a.png", compress: true })
		const b = dedupTreeKey({ path: "/camera roll/b.jpg", compress: true })

		expect(a).not.toBe(b)
	})

	it("strips the extension when convertHeic is ON even if compress is OFF", () => {
		expect(dedupTreeKey({ path: "/camera roll/photo.heic", compress: false, convertHeic: true })).toBe("/camera roll/photo")
	})

	it("convertHeic ON: local .heic and remote .jpg collapse to one key (HEIC→JPG symmetry)", () => {
		// listLocal lists the source .heic; listRemote lists the converted .jpg.
		// Both must dedup to the identical stem key or the asset re-uploads every sync.
		const local = dedupTreeKey({ path: "/camera roll/photo.heic", compress: false, convertHeic: true })
		const remote = dedupTreeKey({ path: "/camera roll/photo.jpg", compress: false, convertHeic: true })

		expect(local).toBe(remote)
		expect(local).toBe("/camera roll/photo")
	})

	it("keeps the full path when BOTH compress and convertHeic are OFF", () => {
		expect(dedupTreeKey({ path: "/camera roll/photo.heic", compress: false, convertHeic: false })).toBe("/camera roll/photo.heic")
	})
})

// Toggle-safety: users flip compress / convertHeic at will, even mid-run. The
// dedup key must stay stable so a settings change never makes a synced asset look
// "missing remotely" and re-upload forever. These guard the invariant at the key
// level (the integration loop tests live in cameraUpload.test.ts).
describe("dedup key stability across compress/convertHeic toggle states", () => {
	it("local .heic and remote .jpg collapse to the SAME key in every stripped state", () => {
		const localHeic = "/camera roll/photo.heic"
		const remoteJpg = "/camera roll/photo.jpg"
		const strippedStates = [
			{ compress: true, convertHeic: false },
			{ compress: false, convertHeic: true },
			{ compress: true, convertHeic: true }
		]

		for (const state of strippedStates) {
			expect(dedupTreeKey({ path: localHeic, ...state })).toBe(dedupTreeKey({ path: remoteJpg, ...state }))
		}
	})

	it("the stem key is identical across all three stripped states (toggling among them never re-keys)", () => {
		const path = "/camera roll/photo.heic"
		const compressOnly = dedupTreeKey({ path, compress: true, convertHeic: false })
		const convertOnly = dedupTreeKey({ path, compress: false, convertHeic: true })
		const both = dedupTreeKey({ path, compress: true, convertHeic: true })

		expect(compressOnly).toBe(convertOnly)
		expect(convertOnly).toBe(both)
		expect(both).toBe("/camera roll/photo")
	})

	it("only the both-OFF state keys on the full extension (the single re-key boundary)", () => {
		const path = "/camera roll/photo.heic"

		expect(dedupTreeKey({ path, compress: false, convertHeic: false })).toBe("/camera roll/photo.heic")
		expect(dedupTreeKey({ path, compress: true, convertHeic: false })).not.toBe(
			dedupTreeKey({ path, compress: false, convertHeic: false })
		)
	})
})

describe("#15 — compress-rename key symmetry through the collision suffix", () => {
	it("local (.png, stem name) and remote (.jpg, stem name) collision suffixes match at iteration 0", () => {
		// listLocal strips the extension from both the key AND the collision name when
		// compress is on; listRemote does the same. The seconds-timestamp suffix path
		// must therefore be identical for the same physical asset across both trees.
		const contentHash = String(Math.floor(1700000000000 / 1000))

		const local = modifyAssetPathOnCollision({
			iteration: 0,
			path: dedupTreeKey({ path: "/camera roll/photo.png", compress: true }),
			asset: { name: stripFilenameExtension("photo.png"), contentHash }
		})
		const remote = modifyAssetPathOnCollision({
			iteration: 0,
			path: dedupTreeKey({ path: "/camera roll/photo.jpg", compress: true }),
			asset: { name: stripFilenameExtension("photo.jpg"), contentHash }
		})

		expect(local).toBe(remote)
		// No extension leaks into the suffix path.
		expect(local).not.toMatch(/\.(png|jpg)$/)
	})

	it("local (.png, stem name) and remote (.jpg, stem name) collision suffixes match at iteration 1", () => {
		const contentHash = String(Math.floor(1700000000000 / 1000))

		const local = modifyAssetPathOnCollision({
			iteration: 1,
			path: dedupTreeKey({ path: "/camera roll/photo.png", compress: true }),
			asset: { name: stripFilenameExtension("photo.png"), contentHash }
		})
		const remote = modifyAssetPathOnCollision({
			iteration: 1,
			path: dedupTreeKey({ path: "/camera roll/photo.jpg", compress: true }),
			asset: { name: stripFilenameExtension("photo.jpg"), contentHash }
		})

		expect(local).toBe(remote)
	})
})

// ─── #B7 — ONE timestamp rule keeps null-creationTime keys symmetric ──────────

describe("#B7 — null-creationTime local/remote key symmetry through the upload round-trip", () => {
	it("the local identity (creationTime ?? modificationTime ?? 0) mirrors remotely because the upload sends the SAME value as `created`", () => {
		// The remote side derives its hash from `meta.created` — which IS the value
		// this pipeline uploaded: effectiveCreationTimestamp(info). So whatever the
		// local fallback resolves to (modificationTime here), the remote listing
		// reproduces it and the keys stay symmetric. (The previous rule — local key
		// falls back to 0 while the upload sent modificationTime — made the remote
		// key diverge for every null-creationTime asset with a modificationTime.)
		const info = { creationTime: null, modificationTime: 9999000 }
		const uploadedCreated = effectiveCreationTimestamp(info)

		expect(uploadedCreated).toBe(9999000)

		const localHash = String(Math.floor(effectiveCreationTimestamp(info) / 1000))
		const remoteCreated: bigint = BigInt(uploadedCreated) // what the next listing returns
		const remoteHash = String(Math.floor(Number(remoteCreated ?? 0) / 1000))

		expect(localHash).toBe("9999")
		expect(remoteHash).toBe("9999")
		expect(localHash).toBe(remoteHash)

		// The collision paths built from the symmetric hashes match.
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

	it("both-null timestamps resolve to epoch 0 on both sides (created=0 survives the upload)", () => {
		// effectiveCreationTimestamp(null, null) = 0; the upload sends created=0
		// (transferCore null-guards instead of falsy-dropping), so the remote
		// `meta.created ?? 0` produces "0" either way — symmetric.
		const info = { creationTime: null, modificationTime: null }

		expect(effectiveCreationTimestamp(info)).toBe(0)

		const localHash = String(Math.floor(effectiveCreationTimestamp(info) / 1000))
		const remoteHash = String(Math.floor(Number(0n) / 1000))

		expect(localHash).toBe("0")
		expect(remoteHash).toBe("0")
	})
})

// ─── isDirUsable (camera-upload destination availability) ────────────────────

describe("isDirUsable", () => {
	it("returns true for a directory with a real (Uuid) parent", () => {
		const dir = { uuid: "dir-uuid", parent: { tag: "Uuid", inner: ["parent-uuid"] } } as any

		expect(isDirUsable(dir)).toBe(true)
	})

	it("returns false when the directory is undefined (permanently deleted on the server)", () => {
		expect(isDirUsable(undefined)).toBe(false)
	})

	it("returns false when the directory is in the trash (parent tag Trash)", () => {
		const dir = { uuid: "dir-uuid", parent: { tag: "Trash" } } as any

		expect(isDirUsable(dir)).toBe(false)
	})
})
