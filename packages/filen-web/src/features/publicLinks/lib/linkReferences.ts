import type { DirPublicLink, LinkedDir, LinkedDirsAndFiles } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { runOp } from "@/lib/actions/outcome"
import type { ByteOrigin } from "@/lib/sdk/byteOrigin"
import { originResolver, type ReferenceSourceFactory } from "@/features/preview/lib/referenceResolver"
import type { ReferenceListing } from "@/features/preview/lib/referenceResolver.logic"
import { entryName, toBrowseEntries, type BrowseEntry } from "@/features/publicLinks/lib/browse.logic"

// A public directory link's files as a model's references: the level on screen, and the link's own listing of a
// subdirectory below it, each listed once and only when referenced. Read through the unauthenticated client.
export function linkListing(entries: readonly BrowseEntry[]): ReferenceListing<LinkedDir, ByteOrigin> {
	const dirs: (readonly [string, LinkedDir])[] = []
	const files: (readonly [string, ByteOrigin])[] = []

	for (const entry of entries) {
		if (entry.kind === "dir") dirs.push([entryName(entry), entry.dir])
		else files.push([entryName(entry), { kind: "linkedFile", file: entry.file }])
	}

	return { dirs, files }
}

export function linkReferences(level: readonly BrowseEntry[], link: DirPublicLink): ReferenceSourceFactory {
	return () =>
		originResolver<LinkedDir>(
			() => Promise.resolve(linkListing(level)),
			dir => listedDir(dir, link),
			"anon"
		)
}

// The same from a directory below the level: its listing as already read (`listed`), else read once referenced (a
// search's held listing serves it).
export function linkDirReferences(dir: LinkedDir, link: DirPublicLink, listed: LinkedDirsAndFiles | undefined): ReferenceSourceFactory {
	return () =>
		originResolver<LinkedDir>(
			() => (listed === undefined ? listedDir(dir, link) : Promise.resolve(linkListing(toBrowseEntries(listed)))),
			child => listedDir(child, link),
			"anon"
		)
}

async function listedDir(dir: LinkedDir, link: DirPublicLink): Promise<ReferenceListing<LinkedDir, ByteOrigin>> {
	return linkListing(toBrowseEntries(await runOp(sdkApi.listLinkedDirAnon(dir, link))))
}
