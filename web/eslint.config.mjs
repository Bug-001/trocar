// web/eslint.config.mjs — `npm run lint` (D75①, 0.1): the react-hooks rules and nothing else, over the TypeScript of web/src.
import tsParser from '@typescript-eslint/parser'
import reactHooks from 'eslint-plugin-react-hooks'

export default [
  {
    files: ['web/src/**/*.{ts,tsx}'],
    languageOptions: { parser: tsParser },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
]
