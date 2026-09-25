/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, type ReactNode } from "react"

// Which worker surface the preview viewers are allowed to reach for bytes. The authenticated app
// leaves this at its default ("authed"), so every existing caller keeps hitting the authed
// downloadFileBytes / range-stream path with no change. The UNAUTHENTICATED public-link routes wrap
// their file preview in the provider below with mode="anon", which reroutes the whole-buffer read to
// the anon linked-file worker method and forces the buffered path (the service worker's own wasm
// bundle has no UnauthClient, so range-seek streaming cannot serve a logged-out visitor).
//
// ★ SECURITY: this is the single seam that keeps an authed worker method off the public surface. A
// viewer rendered under mode="anon" must resolve its bytes ONLY through the anon method; nothing here
// carries key material — the mode is a plain string tag, the key still travels through the fabricated
// DriveItem's own decrypted meta as it always has.
export type PreviewAccessMode = "authed" | "anon"

const PreviewAccessModeContext = createContext<PreviewAccessMode>("authed")
const PreviewCacheScopeContext = createContext<string | null>("authed")
// A public link can allow previewing its file but not downloading it; its viewers then offer no way of
// their own to save the bytes. Everything else may.
const PreviewDownloadableContext = createContext(true)

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

export function PreviewDownloadableProvider({ downloadable, children }: { downloadable: boolean; children: ReactNode }) {
	return <PreviewDownloadableContext value={downloadable}>{children}</PreviewDownloadableContext>
}

export function usePreviewDownloadable(): boolean {
	return useContext(PreviewDownloadableContext)
}

// Takes a native <video>/<audio> control bar's own download entry away when the file may not be saved.
export function mediaControlsList(downloadable: boolean): "nodownload" | undefined {
	return downloadable ? undefined : "nodownload"
}
