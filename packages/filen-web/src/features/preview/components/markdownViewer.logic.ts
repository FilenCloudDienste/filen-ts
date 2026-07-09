// Pure logic for markdownViewer.tsx — framework-free so it is testable in node
// (markdownViewer.logic.test.ts) with no DOM involved.

import { isSafeLinkHref } from "@/features/preview/components/docxViewer.logic"

// react-markdown's own `urlTransform` prop, applied to every URL-bearing attribute it finds (href from
// links/autolinks, src from images — the only two possible from pure CommonMark/GFM source, since raw
// HTML in the source is already escaped/dropped rather than parsed into real elements, see
// markdownViewer.tsx's own comment). Reuses docx-viewer's isSafeLinkHref rather than a second
// definition of the same scheme allowlist — one URL-safety verdict for the whole preview surface.
// Returning undefined (not "") drops the attribute entirely: hast-util-to-jsx-runtime omits an
// undefined prop, mirroring docx-viewer's own `removeAttribute` for the same unsafe case. Signature
// intentionally drops react-markdown's own `key`/`node` params (unneeded — every url-bearing attribute
// gets the same scheme check) — TS allows assigning a shorter-arity function where its `UrlTransform`
// type is expected.
export function markdownUrlTransform(url: string): string | undefined {
	return isSafeLinkHref(url) ? url : undefined
}
