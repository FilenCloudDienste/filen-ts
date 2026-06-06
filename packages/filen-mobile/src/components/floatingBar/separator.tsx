import { FadeIn, FadeOut } from "react-native-reanimated"
import { AnimatedView } from "@/components/ui/animated"

const Separator = () => {
	return (
		<AnimatedView
			className="w-px self-stretch bg-border opacity-50"
			entering={FadeIn.duration(180)}
			exiting={FadeOut.duration(120)}
		/>
	)
}

export default Separator
