import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mobile = join(root, "apps/mobile");
const out =
  process.env.LONGBALL_NATIVE_CONFIG_OUTPUT ??
  join(root, ".local/production-native-config");
mkdirSync(out, { recursive: true });
const bytes = readFileSync(join(mobile, "app.json"));
const base = JSON.parse(bytes).expo;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const require = createRequire(import.meta.url);
const mobileRequire = createRequire(join(mobile, "package.json"));
const { IOSConfig } = mobileRequire("expo/config-plugins");
const profile = require(join(mobile, "app.config.js"));
const configuration = (environment, projectRoot) => {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith("EXPO_PUBLIC_")) delete env[key];
  Object.assign(env, {
    EXPO_PUBLIC_ENVIRONMENT: environment,
    NODE_ENV: "production",
    EXPO_NO_DOTENV: "1",
    EXPO_OFFLINE: "1",
    EXPO_NO_TELEMETRY: "1",
    CI: "1",
    LONGBALL_WEB_BASE_PATH: "/LongBall",
  });
  const result = spawnSync(
    process.execPath,
    [
      join(projectRoot, "node_modules/expo/bin/cli"),
      "config",
      "--type",
      "introspect",
      "--json",
    ],
    {
      cwd: projectRoot,
      env,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  writeFileSync(join(out, `${environment}.stderr.log`), result.stderr ?? "");
  assert.equal(
    result.status,
    0,
    `${environment} Expo config introspection failed: ${result.stderr}`,
  );
  const config = JSON.parse(result.stdout);
  writeFileSync(
    join(out, `${environment}.json`),
    JSON.stringify(config, null, 2) + "\n",
  );
  return config;
};
const configurations = () => {
  const sandbox = mkdtempSync(join(tmpdir(), "longball-native-config-"));
  const projectRoot = join(sandbox, "apps/mobile");
  // Introspection reads existing native files. Always start from app sources so
  // an ignored prebuild from another profile cannot change these assertions.
  const generated = new Set([
    "android",
    "ios",
    "node_modules",
    ".expo",
    "dist",
    "dist-web",
  ]);
  try {
    cpSync(mobile, projectRoot, {
      recursive: true,
      filter: (source) => {
        const top = relative(mobile, source).split(sep)[0];
        return !generated.has(top) && !top.startsWith("dist-");
      },
    });
    const linkType = process.platform === "win32" ? "junction" : "dir";
    symlinkSync(
      join(root, "node_modules"),
      join(sandbox, "node_modules"),
      linkType,
    );
    symlinkSync(
      join(mobile, "node_modules"),
      join(projectRoot, "node_modules"),
      linkType,
    );
    return {
      development: configuration("development", projectRoot),
      production: configuration("production", projectRoot),
    };
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
};
const { development, production } = configurations();
const mods = (config) => config._internal.modResults;
const android = (config) =>
  mods(config).android.manifest.manifest.application[0];
const plist = (config) => mods(config).ios.infoPlist;
const schemes = (config) =>
  (plist(config).CFBundleURLTypes ?? []).flatMap(
    (item) => item.CFBundleURLSchemes ?? [],
  );
const androidSchemes = (config) =>
  (android(config).activity ?? []).flatMap((activity) =>
    (activity["intent-filter"] ?? []).flatMap((filter) =>
      (filter.data ?? []).map((item) => item.$?.["android:scheme"]),
    ),
  );
const checks = [];
assert.equal(
  plist(production).NSAppTransportSecurity.NSAllowsArbitraryLoads,
  false,
);
assert.equal(
  plist(production).NSAppTransportSecurity.NSAllowsLocalNetworking,
  false,
);
assert.equal(
  plist(production).NSAppTransportSecurity.NSExceptionDomains,
  undefined,
);
assert.equal(android(production).$["android:usesCleartextTraffic"], "false");
checks.push(
  "Production evaluated iOS ATS and Android manifest refuse cleartext/local exceptions",
);
assert(
  !plist(production).NSBonjourServices?.some(
    (item) => item.replace(/\.$/, "").toLowerCase() === "_expo._tcp",
  ),
);
assert.equal(plist(production).NSLocalNetworkUsageDescription, undefined);
assert(!schemes(production).includes(`exp+${base.slug}`));
assert(!androidSchemes(production).includes(`exp+${base.slug}`));
assert.equal(plist(production).EXDevMenuShowsAtLaunch, false);
assert.equal(plist(production).EXDevMenuShowFloatingActionButton, false);
checks.push(
  "Production strips Expo discovery/generated schemes and disables default dev menu/tools",
);
assert.equal(
  mods(production).ios.entitlements["aps-environment"],
  "production",
);
assert.equal(
  mods(development).ios.entitlements["aps-environment"],
  "development",
);
checks.push(
  "Production/development APNs environment follows build profile without signing/provisioning",
);
assert.equal(
  plist(development).NSAppTransportSecurity.NSAllowsArbitraryLoads,
  true,
);
assert(plist(development).NSBonjourServices.includes("_expo._tcp"));
assert(schemes(development).includes(`exp+${base.slug}`));
assert.equal(android(development).$["android:usesCleartextTraffic"], undefined);
checks.push(
  "Explicit fictional/development trial keeps its recorded dev-client behavior",
);
for (const config of [development, production]) {
  assert.equal(config.orientation, "default");
  assert.equal(config.ios.supportsTablet, true);
  assert.equal(config.ios.requireFullScreen, false);
  assert.deepEqual(IOSConfig.DeviceFamily.getDeviceFamilies(config), [1, 2]);
  assert.equal(plist(config).UIRequiresFullScreen, false);
  for (const orientation of ["UIInterfaceOrientationPortrait", "UIInterfaceOrientationLandscapeLeft", "UIInterfaceOrientationLandscapeRight"]) assert(plist(config).UISupportedInterfaceOrientations.includes(orientation));
  assert.deepEqual([...plist(config)["UISupportedInterfaceOrientations~ipad"]].sort(), ["UIInterfaceOrientationPortrait", "UIInterfaceOrientationPortraitUpsideDown", "UIInterfaceOrientationLandscapeLeft", "UIInterfaceOrientationLandscapeRight"].sort());
  const activity = android(config).activity.find(item => item.$["android:name"] === ".MainActivity");
  assert.equal(activity.$["android:screenOrientation"], "unspecified");
  for (const change of ["orientation", "screenSize", "screenLayout", "keyboard", "keyboardHidden"]) assert(activity.$["android:configChanges"].split("|").includes(change));
  assert.equal(config.experiments.baseUrl, "/LongBall");
  assert.equal(config.ios.bundleIdentifier, base.ios.bundleIdentifier);
  assert.equal(config.android.package, base.android.package);
  assert.equal(
    mods(config).ios.podfileProperties["expo.sqlite.useSQLCipher"],
    "true",
  );
  assert(
    mods(config).android.gradleProperties.some(
      (item) =>
        item.key === "expo.sqlite.useSQLCipher" && item.value === "true",
    ),
  );
  assert.equal(android(config).$["android:allowBackup"], "false");
  assert.equal(
    android(config).$["android:fullBackupContent"],
    "@xml/secure_store_backup_rules",
  );
  assert.equal(
    android(config).$["android:dataExtractionRules"],
    "@xml/secure_store_data_extraction_rules",
  );
  assert(plist(config).NSFaceIDUsageDescription.length > 0);
  for (const name of [
    "longball-native",
    "expo-secure-store",
    "expo-local-authentication",
    "expo-notifications",
  ])
    assert(config._internal.autolinkedModules.includes(name));
  assert(schemes(config).includes("longball"));
}
checks.push(
  "Both profiles support iPhone/iPad, all tablet orientations and resizable Android windows without activity recreation, while retaining app identity, SQLCipher, backups, biometrics and notifications",
);
const originalEnv = process.env.EXPO_PUBLIC_ENVIRONMENT;
const originalBasePath = process.env.LONGBALL_WEB_BASE_PATH;
try {
  delete process.env.LONGBALL_WEB_BASE_PATH;
  process.env.EXPO_PUBLIC_ENVIRONMENT = "production";
  const input = structuredClone(base);
  input.plugins = input.plugins.map((plugin) =>
    plugin === "expo-notifications"
      ? [
          plugin,
          {
            enableRemoteNotifications: false,
            enableBackgroundRemoteNotifications: false,
          },
        ]
      : plugin,
  );
  input.ios.entitlements = { "example.operator-choice": true };
  const before = JSON.stringify(input);
  const result = profile({ config: input });
  assert.equal(JSON.stringify(input), before);
  assert.equal(result.ios.entitlements["aps-environment"], undefined);
  assert.equal(result.ios.entitlements["example.operator-choice"], true);
  const notification = result.plugins.find(
    (plugin) => Array.isArray(plugin) && plugin[0] === "expo-notifications",
  );
  assert.equal(notification[1].enableRemoteNotifications, false);
  assert.equal(notification[1].enableBackgroundRemoteNotifications, false);
  process.env.EXPO_PUBLIC_ENVIRONMENT = "development";
  assert.equal(profile({ config: input }), input);
  for (const environment of ["development", "production"]) {
    process.env.EXPO_PUBLIC_ENVIRONMENT = environment;
    process.env.LONGBALL_WEB_BASE_PATH = "/LongBall";
    assert.equal(profile({ config: input }).experiments.baseUrl, "/LongBall");
    process.env.LONGBALL_WEB_BASE_PATH = "/LongBall/../outside";
    assert.throws(() => profile({ config: input }), /absolute web subpath/);
  }
} finally {
  if (originalBasePath === undefined) delete process.env.LONGBALL_WEB_BASE_PATH;
  else process.env.LONGBALL_WEB_BASE_PATH = originalBasePath;
  if (originalEnv === undefined) delete process.env.EXPO_PUBLIC_ENVIRONMENT;
  else process.env.EXPO_PUBLIC_ENVIRONMENT = originalEnv;
}
assert.equal(hash(readFileSync(join(mobile, "app.json"))), hash(bytes));
checks.push(
  "Static trial source and explicit local-only notification/operator options are preserved",
);
const report = {
  passed: true,
  checks,
  sourceAppJsonSha256: hash(bytes),
  evaluated: {
    production: hash(readFileSync(join(out, "production.json"))),
    development: hash(readFileSync(join(out, "development.json"))),
  },
  scope:
    "Evaluated build configuration only; native Release signing, compilation, runtime and delivery are separate proof.",
};
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
