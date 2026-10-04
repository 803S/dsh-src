// Discover runtime assets instead of maintaining an incomplete leaf-module list.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
export function runtimeFiles(repo) {
  return readdirSync(join(repo, 'lib'), { recursive: true })
    .filter(file => /\.(?:js|py)$/.test(file))
    .map(file => `lib/${file}`).sort();
}
