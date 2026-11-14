import { FORM_RESET_TOOL } from "@/features/pdf/tools/formReset.tool"
import type { PdfTool } from "@/features/pdf/tools/registry"

// Every PDF tool, one line per feature module.
export const PDF_TOOLS: readonly PdfTool[] = [FORM_RESET_TOOL]
