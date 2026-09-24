import eslint from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      '@stylistic': stylistic,
    },
    rules: {
      '@stylistic/quotes': ['warn', 'single'],
      '@stylistic/indent': ['warn', 2, {SwitchCase: 1}],
      '@stylistic/semi': ['warn'],
      '@stylistic/comma-dangle': ['warn', 'always-multiline'],
      '@stylistic/brace-style': ['warn'],
      '@stylistic/max-len': ['warn', 140],
      '@stylistic/comma-spacing': ['error'],
      '@stylistic/no-multi-spaces': ['warn', {ignoreEOLComments: true}],
      '@stylistic/no-trailing-spaces': ['warn'],
      '@stylistic/lines-between-class-members': ['warn', 'always', {exceptAfterSingleLine: true}],
      '@stylistic/member-delimiter-style': ['warn'],
      'dot-notation': 'off',
      'eqeqeq': 'warn',
      'curly': ['warn', 'all'],
      'prefer-arrow-callback': ['warn'],
      'no-console': ['warn'], // use the provided Homebridge log method instead
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
);
