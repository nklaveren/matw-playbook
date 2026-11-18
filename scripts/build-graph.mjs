import { build } from 'esbuild';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(import.meta.dirname, '..');
export async function compileHtml(original) {
const result = await build({
  entryPoints: [resolve(root, 'src/graph.js')], bundle: true, write: false,
  format: 'iife', globalName: 'MATWGraph', minify: true, target: 'es2020', legalComments: 'inline'
});
const marker = /\/\* THREE_GRAPH_BUNDLE_START \*\/[\s\S]*\/\* THREE_GRAPH_BUNDLE_END \*\//;
if (!marker.test(original)) throw new Error('Three.js bundle markers missing');
const bundle = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script').replace(/[ \t]+$/gm, '');
let output = original.replace(marker, () => `/* THREE_GRAPH_BUNDLE_START */\n${bundle}\n/* THREE_GRAPH_BUNDLE_END */`);
const photo = await readFile(resolve(root, 'assets/portrait.jpg'));
const spatialCSS = await readFile(resolve(root, 'src/fullscreen.css'), 'utf8');
output = output.replace(/\/\* SPATIAL_LAYOUT_START \*\/[\s\S]*\/\* SPATIAL_LAYOUT_END \*\//, () => `/* SPATIAL_LAYOUT_START */\n${spatialCSS}\n/* SPATIAL_LAYOUT_END */`);
output = output.replace(/(<img id="profilePortrait"[^>]*src=")[^"]*(")/, `$1data:image/jpeg;base64,${photo.toString('base64')}$2`);
return { html: output, bundleBytes: Buffer.byteLength(bundle) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
const file = resolve(root, 'index.html');
const original = await readFile(file, 'utf8');
const { html: output, bundleBytes } = await compileHtml(original);
if (process.argv.includes('--check')) {
  if (output !== original) throw new Error('Embedded graph or portrait is stale. Run npm run build.');
  console.log('Embedded Three.js graph and portrait are in sync.');
} else {
  await writeFile(file + '.tmp', output);
  await rename(file + '.tmp', file);
  console.log(`Built offline graph: ${bundleBytes} bytes; index.html ${Buffer.byteLength(output)} bytes.`);
}
}
