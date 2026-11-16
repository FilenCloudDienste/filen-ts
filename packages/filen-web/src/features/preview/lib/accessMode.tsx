/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, type ReactNode } from "react"
import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import { bytesOrigin, requireOriginAccess, type ByteOrigin, type OriginAccess } from "@/lib/sdk/byteOrigin"

// Which worker surface the preview viewers are allowed to reach for bytes. The authenticated app
// leaves this at its default ("authed"), so every existing caller keeps hitting the authed
// downloadFileBytes / range-stream path with no change. The UNAUTHENTICATED public-link routes wrap
// their file preview in the provider below with mode="anon", which reroutes every read to the anon
// linked-file worker methods: whole buffers for documents and images (the service worker's own wasm
// bundle has no UnauthClient), and ranges served to the remux worker for video and audio.
//
// ★ SECURITY: this is the single seam that keeps an authed worker method off the public surface. A
// viewer rendered under mode="anon" must resolve its bytes ONLY through the anon method; nothing here
// carries key material — the mode is a plain string tag, the key still travels through the fabricated
// DriveItem's own decrypted meta as it always has.
export type PreviewAccessMode = OriginAccess

const PreviewAccessModeContext = createContext<PreviewAccessMode>("authed")
const PreviewCacheScopeContext = createContext<string | null>(previewCacheScope("authed", undefined))
// A public link can allow previewing its file but not downloading it; its viewers then offer no way of
// their own to save the bytes. Everything else may.
const PreviewDownloadableContext = createContext(true)
// The host's own way to save the open file, for a viewer that cannot show it to offer instead. Null where
// the host offers none of its own (a public link's page carries its own button beside the preview).
const PreviewDownloadContext = createContext<(() => void) | null>(null)

// The preview cache's key scope (previewCache.ts). Authed items share one. A public link's is a
// fingerprint of its key and password, so bytes read under one password are never served under
// another; an anon provider given none caches nothing.
export function previewCacheScope(mode: PreviewAccessMode, linkScope: string | undefined): string | null {
	if (mode === "authed") {
		return "authed"
	}

	return linkScope === undefined ? null : `anon:${linkScope}`
}

export function PreviewAccessModeProvider({
	mode,
	linkScope,
	children
}: {
	mode: PreviewAccessMode
	linkScope?: string
	children: ReactNode
}) {
	return (
		<PreviewAccessModeContext value={mode}>
			<PreviewCacheScopeContext value={previewCacheScope(mode, linkScope)}>{children}</PreviewCacheScopeContext>
		</PreviewAccessModeContext>
	)
}

// Reads the ambient mode; "authed" when no provider is present (the whole existing app), so the
// public routes are the only place "anon" is ever observed.
export function usePreviewAccessMode(): PreviewAccessMode {
	return useContext(PreviewAccessModeContext)
}

export function usePreviewCacheScope(): string | null {
	return useContext(PreviewCacheScopeContext)
}

export function PreviewDownloadableProvider({
	downloadable,
	onDownload,
	children
}: {
	downloadable: boolean
	onDownload?: (() => void) | null
	children: ReactNode
}) {
	return (
		<PreviewDownloadableContext value={downloadable}>
			<PreviewDownloadContext value={downloadable ? (onDownload ?? null) : null}>{children}</PreviewDownloadContext>
		</PreviewDownloadableContext>
	)
}

export function usePreviewDownloadable(): boolean {
	return useContext(PreviewDownloadableContext)
}

export function usePreviewDownload(): (() => void) | null {
	return useContext(PreviewDownloadContext)
}

// Takes a native <video>/<audio> control bar's own download entry away when the file may not be saved.
export function mediaControlsList(downloadable: boolean): "nodownload" | undefined {
	return downloadable ? undefined : "nodownload"
}

// Where a viewer's bytes come from when they are no file of the drive or a link (an archive's entry, an attachment).
// Null everywhere else.
const PreviewByteOriginContext = createContext<ByteOrigin | null>(null)

export function PreviewByteOriginProvider({ origin, children }: { origin: ByteOrigin; children: ReactNode }) {
	return <PreviewByteOriginContext value={origin}>{children}</PreviewByteOriginContext>
}

// The provided origin (an archive's entry: no file of the drive or a link, so nothing a drive action could take), else
// null. Under a public link, one that needs a session throws: every viewer reads its origin through here.
export function useProvidedPreviewOrigin(): ByteOrigin | null {
	const provided = useContext(PreviewByteOriginContext)
	const mode = usePreviewAccessMode()

	if (provided !== null) {
		requireOriginAccess(provided, mode)
	}

	return provided
}

// ★ The one derivation of a viewer's origin: the provided one, else the item read through the client its access mode
// allows (a public link's surface only ever yields an unauthenticated read). Only file items are previewed.
export function usePreviewOrigin(item: DriveItem): ByteOrigin {
	const provided = useProvidedPreviewOrigin()
	const mode = usePreviewAccessMode()

	if (provided !== null) {
		return provided
	}

	const base = asDirectoryOrFile(item)

	// A directory never reaches a viewer; it has no bytes.
	if (base.type === "directory") {
		return bytesOrigin(new Blob([]), base.data.uuid)
	}

	return mode === "anon" ? { kind: "linkedFile", file: base.data } : { kind: "file", file: base.data }
}

// The files beside the previewed one, where the host has its directory's listing at hand and the drive's
// listing cache would not (a public link's directory). Null: the drive's cached listings are asked.
const PreviewSiblingsContext = createContext<readonly DriveItem[] | null>(null)

export function PreviewSiblingsProvider({ siblings, children }: { siblings: readonly DriveItem[]; children: ReactNode }) {
	return <PreviewSiblingsContext value={siblings}>{children}</PreviewSiblingsContext>
}

export function usePreviewSiblings(): readonly DriveItem[] | null {
	return useContext(PreviewSiblingsContext)
}
