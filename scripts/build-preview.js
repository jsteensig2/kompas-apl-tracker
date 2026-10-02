// Builds a single self-contained HTML file (dist/preview.html) that runs the whole app in the
// browser with an in-memory database. Used for the clickable demo; the real app is `npm start`.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const result = await build({
  entryPoints: [`${root}public/js/app.js`],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  write: false,
  plugins: [{
    name: 'preview-transport',
    setup(b) { b.onResolve({ filter: /\/transport\.js$/ }, () => ({ path: `${root}scripts/preview-transport.js` })); },
  }],
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = readFileSync(`${root}public/styles.css`, 'utf8');
const html = `<title>Kompas APL Tracker</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400;500;600;700&display=swap">
<style>${css}</style>
<div id="app"></div>
<div id="toast" class="toast" role="status" hidden></div>
<script src="https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/sql-asm.js"></script>
<script src="https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"></script>
<script type="module">${js}</script>
`;
mkdirSync(`${root}dist`, { recursive: true });
writeFileSync(`${root}dist/preview.html`, html);
console.log(`dist/preview.html written (${Math.round(html.length / 1024)} KB)`);
