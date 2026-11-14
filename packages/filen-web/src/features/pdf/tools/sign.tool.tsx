import { FileKeyIcon } from "lucide-react"
import { SignOverlay, SignPanel } from "@/features/pdf/signing/signingTool"
import { toolEnabled, whileActive, type PdfTool } from "@/features/pdf/tools/registry"

// Protect › Sign with certificate (signing/signingTool.tsx; S is Fill & Sign's signature): the certificate dialog, then the signature placed on
// a page (dragged, with the keyboard, or an empty signature field) and signed as the last step of a save.

export const SIGN_CERTIFICATE_TOOL: PdfTool = {
	id: "sign.certificate",
	ribbon: { tab: "protect", group: "signatures", order: 300 },
	labelKey: "previewPdfSigningTool",
	icon: FileKeyIcon,
	toolClass: "sign",
	actionIds: [],
	actions: [],
	enabledWhen: policy => toolEnabled("sign", policy),
	commands: ["sign.addField"],
	Overlay: SignOverlay,
	Panel: whileActive(SignPanel),
	panelSlot: "top"
}
