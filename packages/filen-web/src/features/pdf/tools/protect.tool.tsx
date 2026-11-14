import { LockKeyholeIcon } from "lucide-react"
import { ProtectPanel } from "@/features/pdf/security/protectPanel"
import { editorWritable, whileActive, type PdfTool } from "@/features/pdf/tools/registry"

// Protect › Protect document: a password to open, restrictions with an owner password, or none, written by the next
// save (AES-256 for anything new; an RC4 file is offered the upgrade). Offered wherever the file may be edited: the
// dialog itself says what the author's restrictions lock (with Unlock), and a signed file asks before its signatures
// are invalidated by the save.
export const PROTECT_DOCUMENT_TOOL_ID = "protect.document"

export const PROTECT_DOCUMENT_TOOL: PdfTool = {
	id: PROTECT_DOCUMENT_TOOL_ID,
	ribbon: { tab: "protect", group: "security", order: 200 },
	labelKey: "previewPdfSecurityTitle",
	icon: LockKeyholeIcon,
	toolClass: "security",
	actionIds: [],
	actions: [],
	enabledWhen: policy => editorWritable(policy) ?? { enabled: true },
	commands: [],
	Panel: whileActive(ProtectPanel)
}
