const { defineConfig } = require('eslint/config');
const expo = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expo,
  {
    ignores: ['.local/**', '.venv/**', '**/dist/**', '**/dist-web/**', 'docs/longball/**', '**/android/**', '**/ios/**'],
  },
]);
