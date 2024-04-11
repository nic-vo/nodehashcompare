import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { createInterface } from 'readline';

/*

This tool will expect image / video data in projectRoot/data, not src/data

*/

const hashJpeg = (file: fs.FileHandle) => {
	// This is a weird detour from async / await
	return new Promise<string>((res, rej) => {
		const hash = createHash('sha256');
		const stream = file.createReadStream();

		// Build a temporary Buffer until the SOS marker is detected
		// Then flip flag
		let tempBuff: Buffer | null = null;
		let SOSReached = false;

		stream.on('error', (err) => {
			rej(err);
		});

		stream.on('data', (chunk) => {
			// Start tempBuff if this is beginning of data
			if (!tempBuff) tempBuff = Buffer.from(chunk);

			// Short circuit to update hash if SOS was reached; chunk probably is image data
			if (SOSReached) {
				hash.update(chunk);
			} else {
				// Add new chunk to tempBuff then check if SOS marker exists
				const chunkedBuffer = Buffer.from(chunk);
				// Create new buffer from array of previous temp and current chunk
				tempBuff = Buffer.concat([tempBuff, chunkedBuffer]);
				// Look for sub-buffer of SOS marker inside tempBuff
				const SOSIndex = tempBuff.indexOf(Buffer.from([0xff, 0xda]));
				if (SOSIndex !== -1) {
					// If index, then SOS is reached and image data is here
					// slice off everything after SOS and start hashing
					SOSReached = true;
					hash.update(tempBuff.subarray(SOSIndex));
				}
			}
			// hash.update(chunk);
		});

		stream.on('end', () => {
			if (!SOSReached) rej(`Couldn't parse this JPEG - marker missing`);
			res(hash.digest('hex'));
		});
	});
};

const hashPng = (file: fs.FileHandle) => {
	return new Promise<string>((res, rej) => {
		const hash = createHash('sha256');
		const stream = file.createReadStream();

		stream.on('error', (err) => {
			rej(err);
		});

		stream.on('data', (chunk) => {
			hash.update(chunk);
		});

		stream.on('end', () => {
			res(hash.digest('hex'));
		});
	});
};

const rl = createInterface({
	input: process.stdin,
	output: process.stdout,
	terminal: false,
});

function askQuestion() {
	return new Promise<string | '__DEFAULT' | '__EXIT'>((res) => {
		rl.question(
			'\n\nYou can supply either:\n\n1. An absolute path to a "data" dir with one sub-level of dirs containing files\n\n2. "__DEFAULT", which indicates you have a "data" dir\nat the same level as the package.json in this tools dir\n\n3. "__EXIT" to exit\n\nInput: ',
			(answer) => {
				res(answer);
			},
		);
	});
}

type HashedEntry = {
	subdir: string;
	file: string;
};

type DuplicateEntry = {
	original: HashedEntry;
	duplicate: HashedEntry;
};

(async () => {
	let dirPath: string | null = null;
	let dirList: string[] | null = null;
	while (!dirList || !dirPath) {
		let inputPath = await askQuestion();
		switch (inputPath) {
			case '__EXIT':
				console.log('\n\nexiting...\n\n');
				process.exit();
			case '__DEFAULT':
				dirPath = path.join(process.cwd(), 'data');
				break;
			case '':
				continue;
			default:
				if (!/data$/.test(inputPath)) continue;
				dirPath = path.resolve(inputPath);
				break;
		}
		try {
			dirList = await fs.readdir(dirPath);
		} catch {}
	}

	console.log('\n\nrunning...\n\n');

	const hashes = new Map<string, HashedEntry>();
	const duplicates: Record<string, DuplicateEntry[]> = {};
	const tracking = {
		unknown: { total: 0, duplicates: 0 },
		jpeg: { total: 0, duplicates: 0 },
		png: { total: 0, duplicates: 0 },
		webm: { total: 0, duplicates: 0 },
		gif: { total: 0, duplicates: 0 },
	};
	for (const subdir of dirList) {
		console.log('scanning', subdir);
		const subDirPath = path.join(dirPath, subdir);
		const subDirContents = await fs.readdir(subDirPath);
		for (const file of subDirContents) {
			const filePath = path.join(subDirPath, file);
			const fileHandle = await fs.open(filePath, 'r');
			const buffer = Buffer.alloc(3);
			await fileHandle.read(buffer, 0, 3, 0);
			if (buffer[0] === 0xff && buffer[1] === 0xd8) {
				tracking.jpeg.total += 1;
				const hash = await hashJpeg(fileHandle);
				if (hashes.has(hash)) {
					const original = hashes.get(hash) as HashedEntry;
					const newDuplicate = { original, duplicate: { subdir, file } };
					duplicates[subdir] = duplicates[subdir]
						? [...duplicates[subdir], newDuplicate]
						: [newDuplicate];
					tracking.jpeg.duplicates += 1;
				} else hashes.set(hash, { subdir, file });
			} else if (buffer[0] === 0x89 && buffer[1] === 0x50) {
				tracking.png.total += 1;
				const hash = await hashPng(fileHandle);
				if (hashes.has(hash)) {
					const original = hashes.get(hash) as HashedEntry;
					const newDuplicate = { original, duplicate: { subdir, file } };
					duplicates[subdir] = duplicates[subdir]
						? [...duplicates[subdir], newDuplicate]
						: [newDuplicate];
					tracking.png.duplicates += 1;
				} else hashes.set(hash, { subdir, file });
			} else if (buffer[0] === 0x1a && buffer[1] === 0x45) {
				tracking.webm.total += 1;
				const sizeHash = (await fileHandle.stat()).size.toString();
				if (hashes.has(sizeHash)) {
					const original = hashes.get(sizeHash) as HashedEntry;
					const newDuplicate = { original, duplicate: { subdir, file } };
					duplicates[subdir] = duplicates[subdir]
						? [...duplicates[subdir], newDuplicate]
						: [newDuplicate];
					tracking.webm.duplicates += 1;
				} else hashes.set(sizeHash, { subdir, file });
			} else if (
				buffer[0] === 0x47 &&
				buffer[1] === 0x49 &&
				buffer[2] === 0x46
			) {
				tracking.gif.total += 1;
			} else {
				console.log(file, 'unknown format');
				console.log(buffer);
				tracking.unknown.total += 1;
			}
		}
	}
	const totalDuplicates = Object.values(duplicates).reduce(
		(sum, current) => (sum += current.length),
		0,
	);
	console.log('\n\n# of duplicates', totalDuplicates);
	console.dir(duplicates);
	console.log('\n\n# of jpegs:', tracking.jpeg.total);
	console.log('# of pngs:', tracking.png.total);
	console.log('# of webms:', tracking.webm.total);
	console.log('# of gifs:', tracking.gif.total);
	console.log('Failed / unknown:', tracking.unknown.total);
	console.log('\nLogging; moving files to output...');

	const stamp = Date.now();
	const outputPath = path.join(
		dirPath.split('\\').slice(0, -1).join('\\'),
		'output',
		stamp.toString(),
	);
	await fs.mkdir(outputPath, { recursive: true });
	await fs.writeFile(
		path.join(outputPath, `log.json`),
		JSON.stringify({ counts: tracking, duplicates }),
	);
	for (const [subdir, pairs] of Object.entries(duplicates)) {
		await fs.mkdir(path.join(outputPath, subdir), { recursive: true });
		for (const pair of pairs) {
			const deletePath = path.join(dirPath, subdir, pair.duplicate.file);
			const createPath = path.join(outputPath, subdir, pair.duplicate.file);
			const copy = await fs.readFile(deletePath);
			await fs.writeFile(createPath, copy);
			await fs.rm(deletePath);
		}
	}

	console.log('\n*** DONE ***\n\n');
	process.exit();
})();
