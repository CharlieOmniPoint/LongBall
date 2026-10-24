const { withInfoPlist, withAndroidManifest } = require("expo/config-plugins");

/** SDK defaults can add dev-client metadata even when its explicit plugin is absent. */
module.exports = (config) => {
  const generatedScheme = `exp+${config.slug}`;
  config = withInfoPlist(config, (mod) => {
    const plist = mod.modResults;
    plist.NSAppTransportSecurity = {
      NSAllowsArbitraryLoads: false,
      NSAllowsLocalNetworking: false,
    };
    if (Array.isArray(plist.NSBonjourServices)) {
      const services = plist.NSBonjourServices.filter(
        (service) => service.toLowerCase().replace(/\.$/, "") !== "_expo._tcp",
      );
      if (services.length) plist.NSBonjourServices = services;
      else delete plist.NSBonjourServices;
    }
    if (
      typeof plist.NSLocalNetworkUsageDescription === "string" &&
      plist.NSLocalNetworkUsageDescription.includes("Expo Dev Launcher")
    )
      delete plist.NSLocalNetworkUsageDescription;
    if (Array.isArray(plist.CFBundleURLTypes))
      plist.CFBundleURLTypes = plist.CFBundleURLTypes.map((item) => ({
        ...item,
        CFBundleURLSchemes: (item.CFBundleURLSchemes ?? []).filter(
          (scheme) => scheme !== generatedScheme,
        ),
      })).filter((item) => item.CFBundleURLSchemes.length > 0);
    return mod;
  });
  return withAndroidManifest(config, (mod) => {
    for (const application of mod.modResults.manifest.application ?? []) {
      application.$ = {
        ...application.$,
        "android:usesCleartextTraffic": "false",
      };
      for (const activity of application.activity ?? []) {
        activity["intent-filter"] = (activity["intent-filter"] ?? [])
          .map((filter) => {
            if (!Array.isArray(filter.data)) return filter;
            const data = filter.data.filter(
              (item) => item.$?.["android:scheme"] !== generatedScheme,
            );
            return data.length ? { ...filter, data } : null;
          })
          .filter(Boolean);
      }
    }
    return mod;
  });
};
