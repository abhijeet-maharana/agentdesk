// Bundles the widget into public/widget.js and the team inbox into public/inbox.js: Preact (React-compatible, ~10 KB) instead of
// React, and the CSS inlined as text for the shadow root.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(path.join(root, 'public'), { recursive: true });

const shared = {
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

// widget.js for your site's visitors, inbox.js for your team.
const builds = [
  {
    ...shared,
    entryPoints: [path.join(root, 'widget/src/embed.tsx')],
    outfile: path.join(root, 'public/widget.js'),
  },
  {
    ...shared,
    entryPoints: [path.join(root, 'widget/src/inbox/embed.tsx')],
    outfile: path.join(root, 'public/inbox.js'),
  },
];

if (process.argv.includes('--watch')) {
  for (const options of builds) await (await esbuild.context(options)).watch();
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
