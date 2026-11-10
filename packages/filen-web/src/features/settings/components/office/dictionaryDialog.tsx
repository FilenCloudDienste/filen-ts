import { useEffect, useState, useSyncExternalStore } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { BookXIcon } from "lucide-react"
import { userDictionary } from "@/features/spellcheck/lib/userDictionary"
import { ListFilterInput } from "@/components/listFilterInput"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from "@/components/ui/empty"
import { LoadingState } from "@/components/loadingState"
import { log } from "@/lib/log"
import { DictionaryWords } from "@/features/settings/components/office/dictionaryWords"

const COLLATOR = new Intl.Collator(undefined, { sensitivity: "base" })

function subscribeWords(listener: () => void): () => void {
	return userDictionary.subscribe(listener)
}

function currentWords(): readonly string[] {
	return userDictionary.words()
}

// The words the user added to the spelling dictionary (.filen/office/user-dictionary.v1.json), each removable. Read
// when the dialog first opens; a removal shows at once and is uploaded on its own (the toast tells a failed one).
export function DictionaryDialog({
	open,
	online,
	onOpenChange
}: {
	open: boolean
	online: boolean
	onOpenChange: (open: boolean) => void
}) {
	const { t } = useTranslation("settings")
	const words = useSyncExternalStore(subscribeWords, currentWords, currentWords)
	const [status, setStatus] = useState<"loading" | "ready" | "failed">(() => (userDictionary.isLoaded ? "ready" : "loading"))
	const [query, setQuery] = useState("")

	useEffect(() => {
		if (!open) {
			return
		}

		let live = true

		userDictionary.load().then(
			() => {
				if (live) setStatus("ready")
			},
			(error: unknown) => {
				log.warn("spellcheck", "user dictionary not loaded", { error })

				if (live) setStatus(userDictionary.isLoaded ? "ready" : "failed")
			}
		)

		return () => {
			live = false
		}
	}, [open])

	const needle = query.trim().toLocaleLowerCase()
	const shown = (needle === "" ? [...words] : words.filter(word => word.toLocaleLowerCase().includes(needle))).sort(COLLATOR.compare)

	function remove(word: string): void {
		userDictionary.remove(word).catch((error: unknown) => {
			log.warn("spellcheck", "user dictionary not saved", { error })
			toast.error(t("settingsDocumentsSaveFailed"))
		})
	}

	return (
		<Dialog
			open={open}
			onOpenChange={onOpenChange}
		>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{t("settingsOfficeDictionary")}</DialogTitle>
					<DialogDescription>
						{status === "ready"
							? t("settingsOfficeDictionaryCount", { count: words.length })
							: t("settingsOfficeDictionaryDescription")}
					</DialogDescription>
				</DialogHeader>
				{status === "loading" ? (
					<LoadingState
						size="md"
						className="h-80"
					/>
				) : status === "failed" ? (
					<Empty className="h-80">
						<EmptyHeader>
							<EmptyDescription>{t("settingsOfficeDictionaryLoadFailed")}</EmptyDescription>
						</EmptyHeader>
					</Empty>
				) : (
					<div className="flex flex-col gap-3">
						{words.length > 0 ? (
							<ListFilterInput
								value={query}
								onChange={setQuery}
								placeholder={t("settingsOfficeDictionaryFilter")}
								ariaLabel={t("settingsOfficeDictionaryFilter")}
							/>
						) : null}
						{shown.length === 0 ? (
							<Empty className="h-80">
								<EmptyHeader>
									<EmptyMedia>
										<BookXIcon />
									</EmptyMedia>
									<EmptyDescription>
										{words.length === 0 ? t("settingsOfficeDictionaryEmpty") : t("settingsOfficeDictionaryNoMatch")}
									</EmptyDescription>
								</EmptyHeader>
							</Empty>
						) : (
							<DictionaryWords
								words={shown}
								online={online}
								onRemove={remove}
							/>
						)}
					</div>
				)}
			</DialogContent>
		</Dialog>
	)
}
