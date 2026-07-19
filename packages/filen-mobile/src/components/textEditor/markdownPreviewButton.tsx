import View, { CrossGlassContainerView } from "@/components/ui/view"
import { useKeyboardState } from "react-native-keyboard-controller"
import { useResolveClassNames } from "uniwind"
import FontAwesome6 from "@expo/vector-icons/FontAwesome6"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useSecureStore } from "@/lib/secureStore"
import { PressableScale } from "@/components/ui/pressables"
import { useShallow } from "zustand/shallow"
import useTextEditorStore from "@/stores/useTextEditor.store"

const MarkdownPreviewButton = ({ id }: { id: string }) => {
	const keyboardState = useKeyboardState()
	const textForeground = useResolveClassNames("text-foreground")
	const insets = useSafeAreaInsets()
	const [textEditorMarkdownPreviewActive, setTextEditorMarkdownPreviewActive] = useSecureStore<Record<string, boolean>>(
		"textEditorMarkdownPreviewActive",
		{}
	)
	const textEditorReady = useTextEditorStore(useShallow(state => state.ready))

	const active = textEditorMarkdownPreviewActive[id] ?? false

	const onPress = () => {
		if (!id) {
			return
		}

		setTextEditorMarkdownPreviewActive(prev => ({
			...prev,
			[id]: !prev[id]
		}))
	}

	if (keyboardState.isVisible || !textEditorReady) {
		return null
	}

	return (
		<View
			className="absolute bg-transparent z-50"
			style={{
				bottom: 16 + insets.bottom,
				right: 16 + insets.right
			}}
		>
			<CrossGlassContainerView className="flex-row items-center justify-center rounded-full overflow-hidden size-12">
				<PressableScale
					rippleColor="transparent"
					onPress={onPress}
				>
					<FontAwesome6
						name={active ? "eye-slash" : "eye"}
						size={18}
						color={textForeground.color}
					/>
				</PressableScale>
			</CrossGlassContainerView>
		</View>
	)
}

export default MarkdownPreviewButton
