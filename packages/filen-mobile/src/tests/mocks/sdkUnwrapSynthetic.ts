/**
 * Plain-function mock of @/lib/sdkUnwrap for Vitest that interprets the synthetic SDK shapes the
 * offline suites build (meta `{ tag: "Decoded", inner: [meta] }`, parent `{ tag: "Uuid" | "Trash" }`,
 * dirs `{ tag: "Normal" | "Shared" | "Linked", inner: [...] }`) and returns the matching DriveItem shape.
 * Plain functions, not vi.fn: immune to resetAllMocks, and no call recording to distort bench timings.
 *
 * Usage in test files:
 *
 *   vi.mock("@/lib/sdkUnwrap", async () => await import("@/tests/mocks/sdkUnwrapSynthetic"))
 */

type SyntheticMeta = {
	tag?: string
	inner?: unknown[]
}

type SyntheticItem = {
	uuid?: string
	parent?: unknown
	meta?: SyntheticMeta
}

type DecodedMeta = {
	name: string
	size?: bigint
	modified?: number
	created?: number
}

function decodedMeta(item: SyntheticItem | undefined): DecodedMeta | null {
	return item?.meta?.tag === "Decoded" ? ((item.meta.inner?.[0] as DecodedMeta | undefined) ?? null) : null
}

// Mirrors the real Normal vs Shared/Linked walk.
export function unwrapAnyDirUuid(dir: unknown): string | null {
	const d = dir as {
		tag?: string
		inner?: [
			{
				inner?: [{ uuid?: string }]
				dir?: { inner?: [{ inner?: { uuid?: string } }] }
			}
		]
	}
	const inner = d?.inner?.[0]

	switch (d?.tag) {
		case "Normal": {
			return inner?.inner?.[0]?.uuid ?? null
		}

		case "Shared":
		case "Linked": {
			return inner?.dir?.inner?.[0]?.inner?.uuid ?? null
		}

		default: {
			return null
		}
	}
}

export function unwrapFileMeta(file: unknown) {
	const f = file as SyntheticItem
	const meta = decodedMeta(f)

	return {
		file: f,
		meta,
		undecryptable: meta === null,
		shared: false,
		root: false
	}
}

export function unwrapDirMeta(dir: unknown) {
	const d = dir as SyntheticItem
	const meta = decodedMeta(d)

	return {
		dir: d,
		uuid: d?.uuid ?? "unknown",
		meta,
		undecryptable: meta === null,
		shared: false
	}
}

export function unwrappedFileIntoDriveItem(unwrapped: { file: SyntheticItem; meta: DecodedMeta | null }) {
	return {
		type: "file" as const,
		data: {
			uuid: unwrapped.file?.uuid ?? "file-uuid",
			parent: unwrapped.file?.parent,
			decryptedMeta: unwrapped.meta
				? {
						name: unwrapped.meta.name,
						size: unwrapped.meta.size ?? 100n,
						modified: unwrapped.meta.modified ?? 1000,
						created: unwrapped.meta.created ?? 900
					}
				: null,
			undecryptable: unwrapped.meta === null
		}
	}
}

export function unwrappedDirIntoDriveItem(unwrapped: { dir: SyntheticItem; uuid: string; meta: DecodedMeta | null }) {
	return {
		type: "directory" as const,
		data: {
			uuid: unwrapped.uuid ?? unwrapped.dir?.uuid ?? "dir-uuid",
			parent: unwrapped.dir?.parent,
			decryptedMeta: unwrapped.meta
				? {
						name: unwrapped.meta.name,
						size: 0n,
						modified: 1000,
						created: 900
					}
				: null,
			undecryptable: unwrapped.meta === null
		}
	}
}

export function unwrapParentUuid(parent: unknown): string | null {
	const p = parent as { tag?: string; inner?: string[] } | null

	return p?.tag === "Uuid" ? (p.inner?.[0] ?? null) : null
}

export function isTrashParent(parent: unknown): boolean {
	return (parent as { tag?: string } | null)?.tag === "Trash"
}
