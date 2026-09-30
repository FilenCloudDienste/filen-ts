import { PreviewSpinner } from "@/components/drivePreview/previewStatus"
import type React from "react"

const PreviewSlot = ({ isActive, children }: { isActive: boolean; children: React.ReactNode }) => {
	return isActive ? <>{children}</> : <PreviewSpinner className="bg-transparent" />
}

export default PreviewSlot
