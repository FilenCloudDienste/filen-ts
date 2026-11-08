import type { DocxCommandLabels } from "@/features/preview/components/docxEditor.logic"

// Fields, bookmarks and tables of contents: inserted from the Insert menu and its dialogs, updated from the
// chip at a field (docxFieldChip.tsx) and the context menu.
export const FIELDS_LABELS: Required<DocxCommandLabels<"fields">> = {
	"field.update": "previewDocxUpdateField",
	"field.updateAll": "previewDocxUpdateAllFields",
	"field.unlink": "previewDocxUnlinkFields",
	"toc.insert": "previewDocxInsertToc",
	"toc.update": "previewDocxUpdateToc",
	"insert.pageNumber": "previewDocxInsertPageNumber",
	"insert.pageCount": "previewDocxInsertPageCount",
	"insert.date": "previewDocxInsertDate",
	"bookmark.add": "previewDocxBookmark",
	"insert.field": "previewDocxInsertField",
	"bookmark.delete": "previewDocxBookmarkDelete",
	"bookmark.rename": "previewDocxBookmarkRename"
}
