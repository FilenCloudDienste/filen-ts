import { createContext, useContext } from "react"
import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import { fetchDirectoryListing, findCachedDirectoryListing } from "@/features/drive/queries/drive"
import { currentRootUuid } from "@/features/drive/lib/actions"
import { originSize, type ByteOrigin } from "@/lib/sdk/byteOrigin"
import { sdkApi } from "@/lib/sdk/client"
import { loadOriginBytes } from "@/features/preview/lib/origin/loadBytes"
import { referenceWalker, type ReferenceListing, type ReferenceLookup } from "@/features/preview/lib/referenceResolver.logic"
import { usePreviewAccessMode, useProvidedPreviewOrigin, type PreviewAccessMode } from "@/features/preview/lib/accessMode"

// Where a viewer of a multi-file format finds the files its file references, per surface:
//   drive        the model's directory as a cached listing holds it, else its parent listed once; a subdirectory
//                from the cache, else listed once (own directories; a shared one only as cached);
//   public link  the link page's directory and the link's own listings below it (provided by the link page);
//   archive      the archive's own listing, entry by entry (provided by the archive viewer);
//   anything else (a single-file link, an attachment) resolves nothing.
// A resolved file is read whole through the byte layer, not cached: the viewer keeps what it parsed.

export type ResolvedReference =
	| { readonly status: "found"; readonly size: number; readonly read: (cap: number, signal: AbortSignal) => Promise<Uint8Array> }
	| Exclude<ReferenceLookup<never>, { status: "found" }>

export type ReferenceResolver = (path: string) => Promise<ResolvedReference>

// The resolver for the model `item`; a provider's replaces the drive's. Called once per load, never in render.
export type ReferenceSourceFactory = (item: DriveItem) => ReferenceResolver | null

// Provided by a surface with listings of its own (a public link's directory, an archive).
export const PreviewReferenceSourceContext = createContext<ReferenceSourceFactory | null>(null)

// Reads `origin` whole under a token of its own, cancelled with `signal`.
export async function readOrigin(origin: ByteOrigin, access: PreviewAccessMode, cap: number, signal: AbortSignal): Promise<Uint8Array> {
	const token = crypto.randomUUID()
	const stop = (): void => {
		void sdkApi.cancelPreviewDownload(token)
	}

	signal.addEventListener("abort", stop, { once: true })

	return await loadOriginBytes(origin, token, { access, cap, store: false, signal }).finally(() => {
		signal.removeEventListener("abort", stop)
	})
}

// A walker over listings of origins, as a resolver.
export function originResolver<D>(
	root: () => Promise<ReferenceListing<D, ByteOrigin>>,
	child: (dir: D) => Promise<ReferenceListing<D, ByteOrigin>>,
	access: PreviewAccessMode
): ReferenceResolver {
	const lookup = referenceWalker(root, child)

	return async path => {
		const found = await lookup(path)

		if (found.status !== "found") return found

		const origin = found.file

		return { status: "found", size: originSize(origin), read: (cap, signal) => readOrigin(origin, access, cap, signal) }
	}
}

// A drive listing's rows as a reference listing: files by their decrypted names, directories as their rows.
export function itemListing(
	items: readonly DriveItem[],
	originOf: (item: DriveItem) => ByteOrigin
): ReferenceListing<DriveItem, ByteOrigin> {
	const dirs: (readonly [string, DriveItem])[] = []
	const files: (readonly [string, ByteOrigin])[] = []

	for (const item of items) {
		const base = asDirectoryOrFile(item)
		const name = base.data.decryptedMeta?.name

		if (name === undefined) continue

		if (base.type === "directory") dirs.push([name, item])
		else files.push([name, originOf(item)])
	}

	return { dirs, files }
}

function driveOrigin(item: DriveItem): ByteOrigin {
	const base = asDirectoryOrFile(item)

	if (base.type !== "file") throw new Error("a directory has no origin")

	return { kind: "file", file: base.data }
}

// A drive directory in the walk, and whether its listing is the owner's own (the drive's): only an own directory is ever
// listed through the SDK. A shared one's listing needs the share's path, which only its own view has.
interface DriveDirectory {
	readonly item: DriveItem
	readonly own: boolean
}

function directoryListing(items: readonly DriveItem[], own: boolean): ReferenceListing<DriveDirectory, ByteOrigin> {
	const listing = itemListing(items, driveOrigin)

	return { files: listing.files, dirs: listing.dirs.map(([name, item]) => [name, { item, own }] as const) }
}

function cachedDirectory(uuid: string): readonly DriveItem[] | undefined {
	const root = uuid === currentRootUuid() ? null : uuid

	return findCachedDirectoryListing(({ params }) => params.uuid === root || params.uuid === uuid)?.rows
}

async function driveDirectory(directory: DriveDirectory): Promise<ReferenceListing<DriveDirectory, ByteOrigin>> {
	const cached = cachedDirectory(directory.item.data.uuid)

	if (cached !== undefined) return directoryListing(cached, directory.own)

	return directory.own && directory.item.type === "directory"
		? directoryListing(await fetchDirectoryListing("drive", directory.item.data.uuid), true)
		: { dirs: [], files: [] }
}

export function driveReferences(item: DriveItem): ReferenceResolver {
	return originResolver<DriveDirectory>(
		async () => {
			const holding = findCachedDirectoryListing(({ rows }) => rows.some(row => row.data.uuid === item.data.uuid))

			if (holding !== null) return directoryListing(holding.rows, holding.own)

			// Opened from a flat listing (recents, favorites, search, links): an own file's directory is listed once.
			if (item.type !== "file") return { dirs: [], files: [] }

			const parent = item.data.parent
			const cached = cachedDirectory(parent)

			return directoryListing(cached ?? (await fetchDirectoryListing("drive", parent === currentRootUuid() ? null : parent)), true)
		},
		driveDirectory,
		"authed"
	)
}

// The resolver a viewer of `item` gets on its surface, or null where nothing resolves. A provided byte origin (an
// archive's entry, an attachment) resolves only through a provider.
export function usePreviewReferences(): ReferenceSourceFactory {
	const provided = useContext(PreviewReferenceSourceContext)
	const origin = useProvidedPreviewOrigin()
	const access = usePreviewAccessMode()

	if (provided !== null) return provided

	return origin === null && access === "authed" ? driveReferences : () => null
}
