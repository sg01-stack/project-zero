import { readFile, writeFile, mkdir } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const sources = await Promise.all(['src/audio-engine.mjs', 'src/capture.mjs', 'src/app.mjs'].map(p => readFile(new URL(p, root), 'utf8')));
const bundle = sources.map(s => s.replace(/^import .*;\n/gm, '').replace(/^export /gm, '')).join('\n');
if (bundle.toLowerCase().includes('</script')) throw new Error('Unsafe inline script content');
const css = await readFile(new URL('style.css', root), 'utf8');
if (css.toLowerCase().includes('</style')) throw new Error('Unsafe inline style content');
const html = (await readFile(new URL('index.html', root), 'utf8'))
  .replace('<link rel="stylesheet" href="./style.css">', () => `<style>\n${css}</style>`)
  .replace('<script type="module" src="./src/app.mjs"></script>', () => `<script type="module">\n${bundle}\n</script>`);
await mkdir(new URL('dist/', root), { recursive: true });
await writeFile(new URL('dist/echosphere.html', root), html);
console.log('Built dist/echosphere.html (self-contained; no external dependencies).');
