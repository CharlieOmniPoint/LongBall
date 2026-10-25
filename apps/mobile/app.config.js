/** Build-time native policy. The fictional/dev-client profile stays as app.json records it. */
module.exports = ({ config }) => {
  // Preserve the existing explicit Pages subpath in every build profile.
  const baseUrl = process.env.LONGBALL_WEB_BASE_PATH;
  if (baseUrl) {
    if (!/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(baseUrl))
      throw new Error(
        "Use an explicit absolute web subpath without a trailing slash.",
      );
    config = { ...config, experiments: { ...config.experiments, baseUrl } };
  }
  if (process.env.EXPO_PUBLIC_ENVIRONMENT !== "production") return config;
  let remoteNotifications = true;
  const plugins = (config.plugins ?? []).map((plugin) => {
    const [name, options = {}] = Array.isArray(plugin) ? plugin : [plugin, {}];
    if (name === "expo-notifications") {
      remoteNotifications = options.enableRemoteNotifications !== false;
      return [name, { ...options, mode: "production" }];
    }
    if (name === "expo-dev-client")
      return [
        name,
        {
          ...options,
          addGeneratedScheme: false,
          toolsButton: false,
          showMenuAtLaunch: false,
          skipOnboarding: true,
        },
      ];
    return plugin;
  });
  const entitlements = { ...config.ios?.entitlements };
  if (remoteNotifications) entitlements["aps-environment"] = "production";
  else delete entitlements["aps-environment"];
  return {
    ...config,
    ios: {
      ...config.ios,
      entitlements,
      infoPlist: {
        ...config.ios?.infoPlist,
        NSAppTransportSecurity: {
          NSAllowsArbitraryLoads: false,
          NSAllowsLocalNetworking: false,
        },
      },
    },
    // Mod actions run in reverse registration order: register this first so
    // its production cleanup executes after the SDK's dev-client mutations.
    plugins: ["./plugins/withProductionNative", ...plugins],
  };
};
