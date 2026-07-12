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

export function PreviewAccessModeProvider({ mode, children }: { mode: PreviewAccessMode; children: ReactNode }) {
	return <PreviewAccessModeContext value={mode}>{children}</PreviewAccessModeContext>
}

// Reads the ambient mode; "authed" when no provider is present (the whole existing app), so the
// public routes are the only place "anon" is ever observed.
export function usePreviewAccessMode(): PreviewAccessMode {
	return useContext(PreviewAccessModeContext)
}
