// Bundles the widget into public/widget.js: Preact (React-compatible, ~10 KB) instead of
// React, and the CSS inlined as text for the shadow root.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(path.join(root, 'public'), { recursive: true });

const options = {
  entryPoints: [path.join(root, 'widget/src/embed.tsx')],
  outfile: path.join(root, 'public/widget.js'),
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2020'],
  jsx: 'automatic',
  jsxImportSource: 'preact',
  alias: {
    react: 'preact/compat',
    'react-dom/client': 'preact/compat/client',
    'react-dom': 'preact/compat',
    'react/jsx-runtime': 'preact/jsx-runtime',
  },
  loader: { '.css': 'text' },
  legalComments: 'none',
  logLevel: 'info',
};

if (process.argv.includes('--watch')) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
