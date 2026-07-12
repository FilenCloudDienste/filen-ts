// Pure render-gating logic for driveTile.tsx's own grid tile — extracted so it is unit-testable
// without mounting the (heavily-hooked: thumbnails, drag-and-drop, context menu) component itself,
// mirroring every other component's own *.logic.ts sibling in this feature.

import { previewType } from "@/features/drive/lib/preview.logic"
import type { DriveItem } from "@/features/drive/lib/item"

// The grid tile's video-type badge (P20a, mobile parity: a play-glyph badge marks video items) —
// reuses previewType (the SAME category resolution canPreview/the preview overlay itself use), so a
// tile's badge can never disagree with what actually opens as a video preview.
export function showVideoBadge(item: DriveItem): boolean {
	return previewType(item) === "video"
}
