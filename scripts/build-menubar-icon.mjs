// Generates the macOS menu bar template icon.
//
// macOS template images are tinted by the system using only their alpha
// channel, so the app icon cannot be reused here: it would render as a solid
// silhouette. This draws a simple record glyph (ring plus centre dot) instead.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import path from "node:path";

const OUTPUT_DIR = path.join(process.cwd(), "public", "app-icons");
const SUPERSAMPLE = 4;

function drawGlyph(size, filled) {
	// Supersample, then box-filter down so the ring edges stay smooth.
	const hi = size * SUPERSAMPLE;
	const coverage = new Float64Array(size * size);
	const center = hi / 2 - 0.5;
	const outerRadius = hi * 0.45;
	const ringThickness = hi * 0.1;
	const innerRadius = outerRadius - ringThickness;
	const dotRadius = hi * 0.17;

	for (let y = 0; y < hi; y += 1) {
		for (let x = 0; x < hi; x += 1) {
			const distance = Math.hypot(x - center, y - center);
			// While recording the glyph is solid so the menu bar shows at a
			// glance that a capture is running.
			const inRing = distance <= outerRadius && (filled || distance >= innerRadius);
			const inDot = distance <= dotRadius;
			if (!inRing && !inDot) {
				continue;
			}
			const index = Math.floor(y / SUPERSAMPLE) * size + Math.floor(x / SUPERSAMPLE);
			coverage[index] += 1;
		}
	}

	const samplesPerPixel = SUPERSAMPLE * SUPERSAMPLE;
	const rgba = Buffer.alloc(size * size * 4);
	for (let index = 0; index < coverage.length; index += 1) {
		const alpha = Math.round((coverage[index] / samplesPerPixel) * 255);
		rgba[index * 4 + 3] = Math.min(255, alpha);
	}
	return rgba;
}

function crc32(buffer) {
	let crc = 0xffffffff;
	for (const byte of buffer) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) {
			crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const checksum = Buffer.alloc(4);
	checksum.writeUInt32BE(crc32(typeAndData));
	return Buffer.concat([length, typeAndData, checksum]);
}

function encodePng(rgba, size) {
	// One filter byte (0 = none) per scanline, as the PNG format requires.
	const raw = Buffer.alloc(size * (size * 4 + 1));
	for (let y = 0; y < size; y += 1) {
		raw[y * (size * 4 + 1)] = 0;
		rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
	}

	const header = Buffer.alloc(13);
	header.writeUInt32BE(size, 0);
	header.writeUInt32BE(size, 4);
	header[8] = 8; // bit depth
	header[9] = 6; // truecolour with alpha

	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(raw, { level: 9 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

for (const [size, name, filled] of [
	[18, "menubar-Template.png", false],
	[36, "menubar-Template@2x.png", false],
	[18, "menubar-recording-Template.png", true],
	[36, "menubar-recording-Template@2x.png", true],
]) {
	const outputPath = path.join(OUTPUT_DIR, name);
	writeFileSync(outputPath, encodePng(drawGlyph(size, filled), size));
	console.log(`[build-menubar-icon] Wrote ${name} (${size}x${size}) -> ${outputPath}`);
}
