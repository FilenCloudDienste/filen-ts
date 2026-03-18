import { memo } from "@/lib/memo"
import Dom from "@/components/docxPreview/dom"

const DocxPreview = memo(({ base64, paddingTop, paddingBottom }: { base64: string; paddingTop?: number; paddingBottom?: number }) => {
	return (
		<Dom
			base64={base64}
			paddingTop={paddingTop}
			paddingBottom={paddingBottom}
			dom={{
				overScrollMode: "never",
				bounces: false
			}}
		/>
	)
})

export default DocxPreview
