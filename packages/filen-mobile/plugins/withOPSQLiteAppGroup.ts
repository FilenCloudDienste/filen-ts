import configPlugins from "@expo/config-plugins"

const { withInfoPlist } = configPlugins

type OPSQLiteAppGroupOptions = {
	appGroupId: string
}

const withOPSQLiteAppGroup: configPlugins.ConfigPlugin<OPSQLiteAppGroupOptions> = (config, { appGroupId }) => {
	return withInfoPlist(config, config => {
		config.modResults["OPSQLite_AppGroup"] = appGroupId

		return config
	})
}

export default withOPSQLiteAppGroup
