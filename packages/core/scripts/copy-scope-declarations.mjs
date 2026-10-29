import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Copy the scope declarations into the build.
 *
 * The declarations are data, and `tsc` does not copy data. The package
 * reads them at runtime, so the build puts them next to the module that
 * reads them.
 */
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(packageRoot, 'src', 'scope-declarations.yaml');
const target = join(packageRoot, 'dist', 'scope-declarations.yaml');

await mkdir(dirname(target), { recursive: true });
await copyFile(source, target);
