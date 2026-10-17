import { readFile, writeFile, mkdir } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const sources = await Promise.all(['src/audio-engine.mjs', 'src/capture.mjs', 'src/experience.mjs', 'src/visuals.mjs', 'src/voice.mjs', 'src/conversation.mjs', 'src/narrative.mjs', 'src/app.mjs'].map(p => readFile(new URL(p, root), 'utf8')));
// A classic script also loads when index.html is opened directly from disk.
// External ES modules are blocked by browsers for file:// documents.
const bundle = `(() => {\n'use strict';\n${sources.map(s => s.replace(/^import .*;\n/gm, '').replace(/^export /gm, '')).join('\n')}\n})();`;
if (bundle.toLowerCase().includes('</script')) throw new Error('Unsafe inline script content');
const css = await readFile(new URL('style.css', root), 'utf8');
if (css.toLowerCase().includes('</style')) throw new Error('Unsafe inline style content');
const html = (await readFile(new URL('index.html', root), 'utf8'))
  .replace('<link rel="stylesheet" href="./style.css">', () => `<style>\n${css}</style>`)
  .replace(/<script defer src="\.\/dist\/app\.js"[^>]*><\/script>/, () => `<script>\n${bundle}\n</script>`);
await mkdir(new URL('dist/', root), { recursive: true });
await writeFile(new URL('dist/app.js', root), bundle + '\n');
await writeFile(new URL('dist/echosphere.html', root), html);
console.log('Built dist/app.js and dist/echosphere.html (core app bundled; speech workers/models load separately on request).');
