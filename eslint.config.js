const js = require("@eslint/js")
const globals = require("globals")

module.exports = [
  {
    ignores: [
      ".agents/**",
      ".codex",
      "coverage/**",
      "logs/**",
      "logs-local/**",
      "node_modules/**",
      "state/**",
      "state-local/**",
    ],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "commonjs",
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ["**/*.mjs"],
    languageOptions: {
      sourceType: "module",
    },
  },
  {
    files: ["spec/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.jasmine,
      },
    },
  },
  {
    rules: {
      semi: ["error", "never"],
    },
  },
]
