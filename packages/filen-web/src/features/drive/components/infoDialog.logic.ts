import { type DriveKey } from "@/lib/i18n"
import { CATEGORY_POLICY, type PreviewCategory } from "@/features/drive/lib/preview.logic"

// The info dialog's "Kind" row value for a file, mapping its resolved preview category to a label key.
// "other" (a non-previewable file) has no meaningful kind to name, so it returns null and the row is
// omitted — the file's MIME-type row still conveys its format. Mirrors filen-mobile's preview-type row.
export function previewKindLabelKey(category: PreviewCategory): DriveKey | null {
	return CATEGORY_POLICY[category].labelKey
}
