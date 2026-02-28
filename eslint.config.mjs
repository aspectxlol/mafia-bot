import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';

var customConfig = defineConfig([
    globalIgnores([
        '.cache',
        '.git',
        'dist',
        'docs',
        'eslint.config.mjs',
        'misc',
        'node_modules',
        'temp',
    ]),
    {
        rules: {
            // Turn off everything strict from the recommended sets
            '@typescript-eslint/explicit-function-return-type': 'off',
            '@typescript-eslint/no-deprecated': 'off',
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-floating-promises': 'off',
            '@typescript-eslint/no-inferrable-types': 'off',
            '@typescript-eslint/no-misused-promises': 'off',
            '@typescript-eslint/no-require-imports': 'off',
            '@typescript-eslint/no-unsafe-argument': 'off',
            '@typescript-eslint/no-unsafe-assignment': 'off',
            '@typescript-eslint/no-unsafe-call': 'off',
            '@typescript-eslint/no-unsafe-enum-comparison': 'off',
            '@typescript-eslint/no-unsafe-member-access': 'off',
            '@typescript-eslint/no-unsafe-return': 'off',
            '@typescript-eslint/no-unused-vars': 'off',
            '@typescript-eslint/no-var-requires': 'off',
            '@typescript-eslint/only-throw-error': 'off',
            '@typescript-eslint/require-await': 'off',
            '@typescript-eslint/restrict-template-expressions': 'off',
            '@typescript-eslint/return-await': 'off',
            '@typescript-eslint/typedef': 'off',
            '@typescript-eslint/unbound-method': 'off',
            'no-unused-vars': 'off',
            'no-undef': 'off',
            'prefer-const': 'off',
            'sort-imports': 'off',
        },
    },
]);

export default tseslint.config(
    eslint.configs.recommended,
    tseslint.configs.recommended,
    {
        languageOptions: {
            parserOptions: {
                tsconfigRootDir: import.meta.dirname,
                project: ['./tsconfig.json', './tsconfig.test.json'],
            },
        },
    },
    customConfig
);
