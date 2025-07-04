const js = require('@eslint/js');
const globals = require('globals');
const { defineConfig } = require('eslint/config');
const nodePlugin = require('eslint-plugin-n');

module.exports = defineConfig({
  files: ['**/*.js'],
  languageOptions: {
    globals: globals.node
  },
  plugins: { js, n: nodePlugin },
  extends: ['js/recommended', 'n/recommended-script']
});
