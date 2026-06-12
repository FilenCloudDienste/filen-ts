import { FadeIn, FadeOut } from "react-native-reanimated"
import { AnimatedView } from "@/components/ui/animated"
import { hairlineWidthStyle } from "@/lib/hairline"

const Separator = () => {
	return (
		<AnimatedView
			className="self-stretch bg-separator opacity-50"
			style={hairlineWidthStyle}
			entering={FadeIn.duration(180)}
			exiting={FadeOut.duration(120)}
		/>
	)
}

export default Separator
