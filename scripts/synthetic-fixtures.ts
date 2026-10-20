import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertSyntheticFixture, romaFixture } from '../packages/testing/src/index';

assertSyntheticFixture(romaFixture);
const output = resolve('.local/fixtures/roma.json');
await mkdir(resolve('.local/fixtures'), { recursive: true });
await writeFile(output, JSON.stringify(romaFixture, null, 2) + '\n');
console.log(`Wrote 13 fictional Roma players (nine selected) to ${output}`);
