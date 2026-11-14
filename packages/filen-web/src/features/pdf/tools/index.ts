import { CROP_TOOL } from "@/features/pdf/tools/crop.tool"
import { FILL_SIGN_TOOLS } from "@/features/pdf/tools/fillSign.tool"
import { FORMS_TOOL } from "@/features/pdf/tools/forms.tool"
import { OCR_TOOL } from "@/features/pdf/tools/ocr.tool"
import { PROTECT_DOCUMENT_TOOL } from "@/features/pdf/tools/protect.tool"
import { REDACT_AREA_TOOL, REDACT_FIND_TOOL, REDACT_TEXT_TOOL } from "@/features/pdf/tools/redact.tool"
import { PAGES_TOOLS } from "@/features/pdf/tools/pages.tool"
import { SIGN_CERTIFICATE_TOOL } from "@/features/pdf/tools/sign.tool"
import { TEXT_ADD_TOOL, TEXT_EDIT_TOOL } from "@/features/pdf/tools/textEdit.tool"
import { SELECT_TOOL } from "@/features/pdf/tools/select.tool"
import { HAND_TOOL } from "@/features/pdf/tools/hand.tool"
import { TEXT_BOX_TOOL } from "@/features/pdf/tools/textBox.tool"
import { DRAW_TOOL } from "@/features/pdf/tools/draw.tool"
import { MARKUP_TOOL } from "@/features/pdf/tools/markup.tool"
import { SHAPES_TOOL } from "@/features/pdf/tools/shapes.tool"
import { STAMP_TOOL } from "@/features/pdf/tools/stamp.tool"
import { ATTACHMENTS_TOOL, COMMENTS_TOOL, NOTE_TOOL } from "@/features/pdf/tools/comment.tool"
import type { PdfTool } from "@/features/pdf/tools/registry"

// Every PDF tool, one line per feature module.
export const PDF_TOOLS: readonly PdfTool[] = [
	FORMS_TOOL,
	...FILL_SIGN_TOOLS,
	SELECT_TOOL,
	HAND_TOOL,
	TEXT_BOX_TOOL,
	DRAW_TOOL,
	MARKUP_TOOL,
	SHAPES_TOOL,
	STAMP_TOOL,
	NOTE_TOOL,
	COMMENTS_TOOL,
	ATTACHMENTS_TOOL,
	...PAGES_TOOLS,
	CROP_TOOL,
	PROTECT_DOCUMENT_TOOL,
	REDACT_AREA_TOOL,
	REDACT_TEXT_TOOL,
	REDACT_FIND_TOOL,
	TEXT_EDIT_TOOL,
	TEXT_ADD_TOOL,
	OCR_TOOL,
	SIGN_CERTIFICATE_TOOL
]
