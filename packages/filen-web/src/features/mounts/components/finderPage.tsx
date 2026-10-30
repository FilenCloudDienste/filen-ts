import { useTranslation } from "react-i18next"
import { FINDER_ROLE } from "@/features/mounts/lib/mountsRoles"
import { HeroSection, MountsPage } from "@/features/mounts/components/mountsPage"
import { FinderCallouts, FinderHero } from "@/features/mounts/components/finderHero"

// Filen in Finder: its card with the switch and Open in Finder, and what keeps it from showing.
export function FinderPage() {
	const { t } = useTranslation("mounts")

	return (
		<MountsPage
			role={FINDER_ROLE}
			title={t("mountsFinder")}
		>
			<HeroSection>
				<FinderHero overview={false} />
				<FinderCallouts />
			</HeroSection>
		</MountsPage>
	)
}
