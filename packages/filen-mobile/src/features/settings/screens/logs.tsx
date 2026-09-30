import { Platform } from "react-native"
import { Fragment, useEffect, useState } from "react"
import useDismissStack from "@/hooks/useDismissStack"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useResolveClassNames } from "uniwind"
import { useTranslation } from "react-i18next"
import { cn } from "@filen/shared"
import Text from "@/components/ui/text"
import { ScreenBody } from "@/components/ui/safeAreaView"
import SettingsHeader from "@/components/ui/settingsHeader"
import VirtualList from "@/components/ui/virtualList"
import ListEmpty from "@/components/ui/listEmpty"
import { PressableOpacity } from "@/components/ui/pressables"
import logger, { LOG_LEVEL_RANK, type LogLevel, type ReadLogEntry } from "@/lib/logger"

// Console look: a real monospace font so the view mirrors the exported NDJSON.
const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" })

const LEVEL_CLASS: Record<LogLevel, string> = {
	error: "text-red-500",
	warn: "text-yellow-500",
	info: "text-blue-500",
	debug: "text-muted-foreground"
}

const LEVEL_FILTERS = ["all", "error", "warn", "info", "debug"] as const

type LevelFilter = (typeof LEVEL_FILTERS)[number]

const FILTER_LABEL_KEY: Record<
	LevelFilter,
	"log_level_all" | "log_level_errors" | "log_level_warnings" | "log_level_info" | "log_level_debug"
> = {
	all: "log_level_all",
	error: "log_level_errors",
	warn: "log_level_warnings",
	info: "log_level_info",
	debug: "log_level_debug"
}

// Only offer filter levels that can actually appear given the logger's effective minLevel — in prod
// minLevel is "warn", so Info/Debug (never captured) aren't shown; in dev all levels are offered.
function visibleLevelFilters(minLevel: LogLevel): readonly LevelFilter[] {
	const minRank = LOG_LEVEL_RANK[minLevel]

	return LEVEL_FILTERS.filter(f => f === "all" || LOG_LEVEL_RANK[f] >= minRank)
}

function pad(value: number, length: number = 2): string {
	return String(value).padStart(length, "0")
}

function formatTimestamp(t: number): string {
	const date = new Date(t)

	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

// readEntries() deserializes log lines back into real types (bigint, Map, Set, …) via the shared
// serializer, so plain JSON.stringify would throw on a bigint. The replacer renders the types bare
// JSON can't: bigint → "<n>n", Map/Set → their entries/values.
function stringifyData(data: unknown): string {
	try {
		return JSON.stringify(
			data,
			(_key, value) => {
				if (typeof value === "bigint") {
					return `${value}n`
				}

				if (value instanceof Map) {
					return Object.fromEntries(value)
				}

				if (value instanceof Set) {
					return Array.from(value)
				}

				return value
			},
			2
		)
	} catch {
		return String(data)
	}
}

const LogRow = ({ entry, expanded, onToggle }: { entry: ReadLogEntry; expanded: boolean; onToggle: () => void }) => {
	const levelClass = LEVEL_CLASS[entry.l]
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
	const dismiss = useDismissStack()
	const insets = useSafeAreaInsets()
	const textForeground = useResolveClassNames("text-foreground")

	const [entries, setEntries] = useState<ReadLogEntry[]>([])
	const [loading, setLoading] = useState<boolean>(true)
	const [expanded, setExpanded] = useState<Set<number>>(new Set())
	const [levelFilter, setLevelFilter] = useState<LevelFilter>("all")

	const visible = levelFilter === "all" ? entries : entries.filter(entry => entry.l === levelFilter)

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
			<SettingsHeader
				title={t("logs")}
				icon="close"
				onDismiss={dismiss}
				rightItems={[
					{
						type: "menu",
						icon: {
							name: "funnel-outline",
							color: textForeground.color,
							size: 20
						},
						props: {
							title: t("filter_logs"),
							buttons: visibleLevelFilters(logger.minLevel).map(level => ({
								id: level,
								title: t(FILTER_LABEL_KEY[level]),
								checked: levelFilter === level,
								onPress: () => {
									setLevelFilter(level)
									setExpanded(new Set())
								}
							}))
						}
					}
				]}
			/>
			<ScreenBody>
				<VirtualList
					data={visible}
					extraData={expanded}
					loading={loading}
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
			</ScreenBody>
		</Fragment>
	)
}

export default Logs
