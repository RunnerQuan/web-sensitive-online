import { cp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, 'dist');
// Only this generated folder may be replaced; server code, credentials and tests never enter the publish directory.
if (dirname(output) !== resolve(root) || output !== resolve(root, 'dist')) throw new Error('Unsafe output directory');
for (const page of ['index.html', 'sixth.html']) {
  const html = await readFile(join(root, page), 'utf8');
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (match[1].trim()) new vm.Script(match[1], { filename: page });
  }
}
new vm.Script(await readFile(join(root, 'assets/dragon-leaderboard.js'), 'utf8'), { filename: 'dragon-leaderboard.js' });
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const file of await readdir(root)) {
  if (file.endsWith('.html')) await cp(join(root, file), join(output, file));
}
await cp(join(root, 'assets'), join(output, 'assets'), { recursive: true });
console.log('Static site built in dist/ (HTML and assets only).');
