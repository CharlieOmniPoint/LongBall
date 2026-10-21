/** Root-mounted exports and native builds keep the supplied application config. */
module.exports = ({ config }) => {
  const baseUrl = process.env.LONGBALL_WEB_BASE_PATH;
  if (!baseUrl) return config;
  if (!/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(baseUrl)) {
    throw new Error(
      "Use an explicit absolute web subpath without a trailing slash.",
    );
  }
  return { ...config, experiments: { ...config.experiments, baseUrl } };
};
