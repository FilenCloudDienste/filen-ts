import { Platform } from "react-native"
import { Fragment, useEffect, useState } from "react"
import { useNavigation } from "expo-router"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useResolveClassNames } from "uniwind"
import { useTranslation } from "react-i18next"
import { cn } from "@filen/utils"
import Text from "@/components/ui/text"
import SafeAreaView from "@/components/ui/safeAreaView"
import Header from "@/components/ui/header"
import VirtualList from "@/components/ui/virtualList"
import ListEmpty from "@/components/ui/listEmpty"
import { PressableOpacity } from "@/components/ui/pressables"
import logger, { type ReadLogEntry } from "@/lib/logger"

// Console look: a real monospace font so the view mirrors the exported NDJSON.
const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" })

const LEVEL_CLASS: Record<string, string> = {
	error: "text-red-500",
	warn: "text-yellow-500",
	info: "text-blue-500",
	debug: "text-muted-foreground"
}

function pad(value: number, length: number = 2): string {
	return String(value).padStart(length, "0")
}

function formatTimestamp(t: number): string {
	const date = new Date(t)

	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

function stringifyData(data: unknown): string {
	try {
		return JSON.stringify(data, null, 2)
	} catch {
		return String(data)
	}
}

const LogRow = ({ entry, expanded, onToggle }: { entry: ReadLogEntry; expanded: boolean; onToggle: () => void }) => {
	const levelClass = LEVEL_CLASS[entry.l] ?? "text-muted-foreground"
	const hasData = entry.data !== undefined

	return (
		<PressableOpacity
			className="px-4 py-2 border-b border-separator bg-transparent"
			disabled={!hasData}
			onPress={onToggle}
		>
			<Text
				style={{ fontFamily: MONO }}
				className="text-xs"
				numberOfLines={1}
			>
				<Text className="text-muted-foreground">{`${formatTimestamp(entry.t)}  `}</Text>
				<Text className={cn("font-semibold", levelClass)}>{entry.l.toUpperCase()}</Text>
				<Text className="text-muted-foreground">{`  ${entry.tag}`}</Text>
			</Text>
			{entry.msg.length > 0 && (
				<Text
					style={{ fontFamily: MONO }}
					className="text-xs text-foreground mt-0.5"
				>
					{entry.msg}
				</Text>
			)}
			{hasData &&
				(expanded ? (
					<Text
						style={{ fontFamily: MONO }}
						className="text-xs text-muted-foreground mt-1"
					>
						{stringifyData(entry.data)}
					</Text>
				) : (
					<Text className="text-xs text-blue-500 mt-0.5">▸ data</Text>
				))}
		</PressableOpacity>
	)
}

const Logs = () => {
	const { t } = useTranslation()
	const navigation = useNavigation()
	const insets = useSafeAreaInsets()
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textForeground = useResolveClassNames("text-foreground")

	const [entries, setEntries] = useState<ReadLogEntry[]>([])
	const [loading, setLoading] = useState<boolean>(true)
	const [expanded, setExpanded] = useState<Set<number>>(new Set())

	useEffect(() => {
		// Reading + parsing the NDJSON is synchronous; defer it one tick so the screen paints (with the
		// loader) immediately and the modal-open animation isn't blocked by the parse.
		const timeout = setTimeout(() => {
			setEntries(logger.readEntries())
			setExpanded(new Set())
			setLoading(false)
		}, 0)

		return () => clearTimeout(timeout)
	}, [])

	return (
		<Fragment>
			<Header
				title={t("logs")}
				transparent={Platform.OS === "ios"}
				shadowVisible={false}
				backVisible={Platform.OS === "android"}
				backgroundColor={Platform.select({
					ios: undefined,
					default: bgBackgroundSecondary.backgroundColor as string
				})}
				leftItems={Platform.select({
					ios: [
						{
							type: "button",
							icon: {
								name: "close",
								color: textForeground.color,
								size: 20
							},
							props: {
								onPress: () => {
									navigation.getParent()?.goBack()
								}
							}
						}
					],
					default: undefined
				})}
			/>
			<SafeAreaView
				className="flex-1 bg-background-secondary"
				edges={["left", "right"]}
			>
				<VirtualList
					data={entries}
					extraData={expanded}
					loading={loading}
					contentInsetAdjustmentBehavior="automatic"
					contentContainerStyle={{
						paddingBottom: insets.bottom
					}}
					onRefresh={() => {
						setEntries(logger.readEntries())
						setExpanded(new Set())
					}}
					keyExtractor={(_item, index) => String(index)}
					renderItem={({ item, index }) => (
						<LogRow
							entry={item}
							expanded={expanded.has(index)}
							onToggle={() =>
								setExpanded(prev => {
									const next = new Set(prev)

									if (next.has(index)) {
										next.delete(index)
									} else {
										next.add(index)
									}

									return next
								})
							}
						/>
					)}
					emptyComponent={() => (
						<ListEmpty
							icon="document-text-outline"
							title={t("no_logs")}
							description={t("no_logs_description")}
						/>
					)}
				/>
			</SafeAreaView>
		</Fragment>
	)
}

export default Logs
