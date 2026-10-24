const { defineConfig } = require('eslint/config');
const expo = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expo,
  { settings: { react: { version: require('./apps/mobile/package.json').dependencies.react } } },
  {
    ignores: ['.local/**', '.venv/**', '**/dist/**', '**/dist-web/**', '**/dist-demo-web/**', '**/dist-web-identity-entry/**', '**/dist-production-review/**', '**/dist-pages/**', 'docs/longball/**', '**/android/**', '**/ios/**'],
  },
]);
