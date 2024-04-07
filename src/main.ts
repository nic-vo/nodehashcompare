import fs from 'fs/promises';
import path from 'path';

/*

This tool will expect image / video data in projectRoot/data, not src/data

*/

const dataDir = path.join(process.cwd(), 'data');
const outputDir = path.join(process.cwd(), 'output');

(async () => {
	const subs = await fs.readdir(dataDir);
})();
