/**
 * Better Thumbnails Modded Plugin
 * 
 * Credits:
 * - Based on 'thumbnails' plugin by Rejetto (https://github.com/rejetto/thumbnails)
 * - FFmpeg integration inspired by 'videojs-player' and 'unsupported-videos'
 * - VenB304 for it's first version.
 */

exports.version = 1;
exports.description = "High-performance thumbnails generation using FFmpeg. Generates animated images preventing frontend lag.";
exports.apiRequired = 12.0; // Access to api.misc
exports.repo = "hfs-other-plugins/better-thumbnails-mod";
exports.frontend_js = 'main.js';

exports.config = {
    quality: {
        type: 'number',
        defaultValue: 60,
        min: 1, max: 100,
        helperText: "WebP Quality (1-100). Lower is smaller file size.",
        xs: 6,
    },
    pixels: {
        type: 'number',
        defaultValue: 256,
        min: 10, max: 2000,
        helperText: "Max width/height of the generated thumbnail (Bounding Box).",
        unit: 'pixels',
        xs: 6,
    },
    concurrency_limit: {
        type: 'number',
        defaultValue: 4,
        min: 1, max: 32,
        label: "Max Concurrent Generations",
        helperText: "Maximum number of parallel thumbnails to generate. Higher = more CPU usage.",
        xs: 6
    },
    ffmpeg_path: {
        type: 'real_path',
        fileMask: 'ffmpeg*',
        label: "FFmpeg Executable Path (Required)",
        helperText: "Path to ffmpeg binary (e.g. C:/ffmpeg/bin/ffmpeg.exe).",
        xs: 12
    },
    log: { type: 'boolean', defaultValue: false, label: "Log thumbnail generation" },
};

exports.init = async api => {
    const { createReadStream, createWriteStream, promises: fs } = api.require('fs');
    const path = api.require('path');
    const crypto = api.require('crypto'); // For MD5 hashing
    const { buffer } = api.require('node:stream/consumers');
    const { spawn } = api.require('child_process');

    const header = 'x-thumbnail';
    const VIDEO_EXTS = ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'ts', 'm4v'];

	// Setup Cache Directory
    const cacheDir = path.join(api.storageDir, 'thumbnails');
    await fs.mkdir(cacheDir, { recursive: true }).catch(err => console.error("BetterThumbnails: Failed to create cache dir", err));

    // Concurrency Queue
    const queue = [];
    let active = 0;
    
    // NEW: Map to track currently generating thumbnails to prevent duplicate FFmpeg spawns
    const inFlightRequests = new Map();

    const runQueue = () => {
        // ... (keep your existing runQueue and enqueue functions) ...
        const limit = api.getConfig('concurrency_limit') || 4;
        if (active >= limit || queue.length === 0) return;

        active++;
        const { task, resolve, reject } = queue.shift();

        task().then(resolve).catch(reject).finally(() => {
            active--;
            runQueue();
        });
    };

    const enqueue = (task) => new Promise((resolve, reject) => {
        queue.push({ task, resolve, reject });
        runQueue();
    });

    const isVideo = (ext) => VIDEO_EXTS.includes(ext);

    return {
        middleware(ctx) {
            if (ctx.query.get !== 'thumb') return;

            ctx.state.considerAsGui = true;
            ctx.state.download_counter_ignore = true;

            return async () => {
                if (!ctx.body && ctx.status !== 200) return; 
                if (ctx.status === 304) return; 

                if (!api.getConfig('log')) ctx.state.dontLog = true;

                const { fileSource, fileStats } = ctx.state;
                if (!fileSource) return;

                const { size, mtimeMs: ts, birthtimeMs } = fileStats || {};
                const fileTs = ts || birthtimeMs;
                const quality = api.getConfig('quality');
                const pixels = api.getConfig('pixels');
                
                // FIX: Fallback properly to prevent 'NaN' in the hash string
                const w = Number(ctx.query.w) || pixels;
                const h = Number(ctx.query.h) || w;

                // 1. Calculate a Robust Cache Key
                // FIX: Added size, sanitized timestamps, and upgraded to SHA-256
                const safeSize = size ? size.toString() : '0';
                const safeTs = fileTs ? Math.floor(fileTs).toString() : '0';
                const cacheKeyStr = `${fileSource}|${safeSize}|${safeTs}|${w}|${h}|${quality}`;
                const cacheHash = crypto.createHash('sha256').update(cacheKeyStr).digest('hex');
                const cacheFile = path.join(cacheDir, cacheHash + '.webp');

                // 2. Check Cache File (Disk)
                try {
                    const stats = await fs.stat(cacheFile);
                    if (stats.size > 0) {
                        ctx.set(header, 'cache-file');
                        ctx.type = 'image/webp';
                        ctx.body = createReadStream(cacheFile);
                        return;
                    }
                } catch (e) { /* Missing cache is normal */ }

                // 3. FIX: Check In-Flight Requests (Memory Deduplication)
                // If this thumbnail is currently being generated by another request, wait for it!
                if (inFlightRequests.has(cacheHash)) {
                    try {
                        const buffer = await inFlightRequests.get(cacheHash);
                        ctx.set(header, 'cache-memory-dedup');
                        ctx.type = 'image/webp';
                        ctx.body = buffer;
                        return;
                    } catch (e) {
                        // If the pending generation failed, fall through to try again
                    }
                }

				// 4. Generate (Queued)
                const ext = path.extname(fileSource).replace('.', '').toLowerCase();

                // Create the generation task as a Promise
                const generationTask = (async () => {
                    const outputBuffer = await enqueue(async () => {
                        if (isVideo(ext)) {
                            ctx.set(header, 'ffmpeg-animated');
                            // BYPASS SHARP: FFmpeg outputs the final Animated WebP buffer directly
                            return await generateAnimatedVideoThumbnail(fileSource, w, quality);
                        } 
                        
                        // IMAGE GENERATION (Fallback to Sharp)
                        if (size > 100 * 1024 * 1024) throw new Error("Image too large (>100MB)");
                        const sourceBuffer = await buffer(ctx.body);
                        ctx.set(header, 'image-generated');
                        
                        if (!sourceBuffer || sourceBuffer.length === 0) throw new Error("Empty buffer");

                        const sharp = api.customApiCall('sharp', sourceBuffer)[0];
                        if (!sharp) throw new Error('Sharp plugin not active');

                        return await sharp.resize(w, h, { fit: 'inside' })
                            .rotate()
                            .webp({ quality })
                            .toBuffer();
                    });

                    // 5. Save to Cache
                    await fs.writeFile(cacheFile, outputBuffer);
                    return outputBuffer;
                })();

                // Store the promise in our map so other requests can hook into it
                inFlightRequests.set(cacheHash, generationTask);

                try {
                    // Await the local execution
                    const outputBuffer = await generationTask;
                    ctx.type = 'image/webp';
                    ctx.body = outputBuffer;
                } catch (e) {
                    console.error(`BetterThumbnails Error [${fileSource}]:`, e.message);
                    ctx.status = 500;
                    ctx.body = e.message;
                } finally {
                    // Always clear the memory cache once done so it serves from disk next time
                    inFlightRequests.delete(cacheHash);
                }
            };
        }
    };

	async function generateAnimatedVideoThumbnail(filePath, width, quality) {
        const ffmpegPath = api.getConfig('ffmpeg_path') || 'ffmpeg';
        const ffprobePath = getFFprobePath(ffmpegPath);
        const os = require('os'); // Ensure 'os' is loaded to grab the system temp folder

        // 1. Get total duration to calculate percentages
        const duration = await getVideoDuration(filePath, ffprobePath);

		// Calculate 1-second segment timestamps
		let segments = [];
		if (duration < 5) { // We check here if the video last less than 5 seconds.
			segments = [{ start: 0, duration: Math.max(1, duration) }];
		} else {
			segments = [
				{ start: Math.min(2, duration - 1), duration: 1 }, // 2 seconds in
				{ start: duration * 0.15, duration: 1 },           // 15%
				{ start: duration * 0.30, duration: 1 },           // 30%
				{ start: duration * 0.45, duration: 1 },           // 45%
				{ start: duration * 0.60, duration: 1 }            // 60%
			];
		}

        // FIX: Create a randomized temporary file path
        const tmpFile = path.join(os.tmpdir(), `ffmpeg-tmp-${Date.now()}-${Math.random().toString(36).slice(2)}.webp`);

        // 3. Construct the FFmpeg command
        return new Promise((resolve, reject) => {
            const args = [];
            
            segments.forEach(seg => {
                args.push('-ss', seg.start.toFixed(2), '-t', seg.duration.toFixed(2), '-i', filePath);
            });

            let filterString = '';
            let concatInputs = '';
            
            segments.forEach((seg, index) => {
                filterString += `[${index}:v]fps=10,scale='min(${width},iw)':-2[v${index}]; `;
                concatInputs += `[v${index}]`;
            });
            
            filterString += `${concatInputs}concat=n=${segments.length}:v=1:a=0[outv]`;

            args.push(
                '-filter_complex', filterString,
                '-map', '[outv]',
                '-c:v', 'libwebp',
                '-loop', '0',               
                '-q:v', quality.toString(), 
                '-an',                      
                '-y',       // Overwrite just in case
                tmpFile     // FIX: Output directly to disk instead of pipe:1
            );

            const proc = spawn(ffmpegPath, args);
            const stderrChunks = [];

            // We no longer need to listen to stdout since it outputs to the file!
            proc.stderr.on('data', chunk => stderrChunks.push(chunk));
            
            proc.on('error', err => reject(err));
            proc.on('exit', async (code) => {
                if (code !== 0) {
                    const stderr = Buffer.concat(stderrChunks).toString();
                    // Clean up the temp file if it was partially written
                    fs.unlink(tmpFile).catch(() => {});
                    return reject(new Error(`FFmpeg animated export failed (Code ${code}). Stderr: ${stderr}`));
                }
                
                try {
                    // Read the correctly formatted, fully-seeked WebP file into memory
                    const fullBuffer = await fs.readFile(tmpFile);
                    
                    // Immediately delete the temporary file so we don't leak storage
                    await fs.unlink(tmpFile).catch(() => {});
                    
                    if (fullBuffer.length === 0) return reject(new Error("FFmpeg produced an empty WebP output"));
                    resolve(fullBuffer);
                } catch (err) {
                    reject(new Error(`Failed to read temporary WebP file: ${err.message}`));
                }
            });
        });
    }

    // Helper to get duration via ffprobe
    function getVideoDuration(filePath, ffprobePath) {
        return new Promise((resolve) => {
            const args = [
                '-v', 'error',
                '-show_entries', 'format=duration',
                '-of', 'default=noprint_wrappers=1:nokey=1',
                filePath
            ];
            const proc = spawn(ffprobePath, args);
            let output = '';
            proc.stdout.on('data', chunk => output += chunk.toString());
            proc.on('error', () => resolve(0));
            proc.on('exit', () => {
                const duration = parseFloat(output.trim());
                resolve(isNaN(duration) ? 0 : duration);
            });
        });
    }

    function getFFprobePath(ffmpegPath) {
        // Simple heuristic: replace 'ffmpeg' with 'ffprobe' in the filename
        const dir = path.dirname(ffmpegPath);
        const ext = path.extname(ffmpegPath);
        const name = path.basename(ffmpegPath, ext);
        
        if (name.toLowerCase() === 'ffmpeg') {
            return path.join(dir, 'ffprobe' + ext);
        }
        return 'ffprobe'; // Default to PATH
    }

    function getAttachedPictureStreamIndex(filePath, ffprobePath) {
        return new Promise((resolve, reject) => {
            // ffprobe to find stream with disposition=attached_pic
            const args = [
                '-v', 'error',
                '-select_streams', 'v',
                '-show_entries', 'stream=index:stream_disposition=attached_pic',
                '-of', 'json',
                filePath
            ];

            const proc = spawn(ffprobePath, args);
            const chunks = [];
            
            proc.stdout.on('data', chunk => chunks.push(chunk));
            proc.on('error', err => reject(err));
            proc.on('exit', (code) => {
                if (code !== 0) return reject(new Error(`ffprobe exited with code ${code}`));
                
                try {
                    const output = Buffer.concat(chunks).toString();
                    const json = JSON.parse(output);
                    
                    if (json.streams) {
                        for (const stream of json.streams) {
                            if (stream.disposition && stream.disposition.attached_pic === 1) {
                                return resolve(stream.index);
                            }
                        }
                    }
                    resolve(null);
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    function extractEmbeddedThumbnail(filePath, streamIndex, ffmpegPath) {
        return new Promise((resolve, reject) => {
            // Extract the specific stream
            // -map 0:v:{index} -c copy (fastest, keeps original format) or -c:v mjpeg to ensure image
            // We use -c:v mjpeg to ensure we get a standard image buffer
            const args = [
                '-i', filePath,
                '-map', `0:${streamIndex}`,
                '-c:v', 'mjpeg', // Convert to mjpeg to be safe/consistent
                '-f', 'image2',
                'pipe:1'
            ];
            
            const proc = spawn(ffmpegPath, args);
            const chunks = [];
            const stderrChunks = [];

            proc.stdout.on('data', chunk => chunks.push(chunk));
            proc.stderr.on('data', chunk => stderrChunks.push(chunk));
            proc.on('error', err => reject(err));
            proc.on('exit', (code) => {
                if (code !== 0) {
                    const stderr = Buffer.concat(stderrChunks).toString();
                    return reject(new Error(`FFmpeg extract failed with code ${code}. Stderr: ${stderr}`));
                }
                const fullBuffer = Buffer.concat(chunks);
                if (fullBuffer.length === 0) return reject(new Error("FFmpeg extracted empty buffer"));
                resolve(fullBuffer);
            });
        });
    }
};
