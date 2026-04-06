/**
 * Better Thumbnails Modded Plugin
 * 
 * Credits:
 * - Based on 'thumbnails' plugin by Rejetto (https://github.com/rejetto/thumbnails)
 * - FFmpeg integration inspired by 'videojs-player' and 'unsupported-videos'
 * - "VenB304" for it's first original version.
 */

exports.version = 6;
exports.description = "High-performance thumbnails generation using FFmpeg. Generates animated images preventing frontend lag.";
exports.apiRequired = 12.0;
exports.repo = "RicardoEstep/hfs-better-thumbnails-mod";
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
    const crypto = api.require('crypto');
    const { buffer } = api.require('node:stream/consumers');
    const { spawn } = api.require('child_process');

    const header = 'x-thumbnail';
    const VIDEO_EXTS = ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'ts', 'm4v'];
    const AUDIO_EXTS = ['mp3', 'aac', 'flac', 'm4a', 'ogg', 'wav', 'opus', 'oga', 'wma'];
    const MEDIA_WITH_COVERS = [...VIDEO_EXTS, ...AUDIO_EXTS];

    const cacheDir = path.join(api.storageDir, 'thumbnails');
    await fs.mkdir(cacheDir, { recursive: true }).catch(err => console.error("BetterThumbnails: Failed to create cache dir", err));

    const queue = [];
    let active = 0;
    const inFlightRequests = new Map();

    const runQueue = () => {
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
                
                const w = Number(ctx.query.w) || pixels;
                const h = Number(ctx.query.h) || w;

                const safeSize = size ? size.toString() : '0';
                const safeTs = fileTs ? Math.floor(fileTs).toString() : '0';
                const cacheKeyStr = `${fileSource}|${safeSize}|${safeTs}|${w}|${h}|${quality}`;
                const cacheHash = crypto.createHash('sha256').update(cacheKeyStr).digest('hex');
                const cacheFile = path.join(cacheDir, cacheHash + '.webp');

                // Check Cache File (Disk)
                try {
                    const stats = await fs.stat(cacheFile);
                    if (stats.size > 0) {
                        ctx.set(header, 'cache-file');
                        ctx.type = 'image/webp';
                        ctx.body = createReadStream(cacheFile);
                        return;
                    }
                } catch (e) { /* Missing cache is normal */ }

                // Check In-Flight Requests (Memory Deduplication)
                if (inFlightRequests.has(cacheHash)) {
                    try {
                        const outputBuffer = await inFlightRequests.get(cacheHash);
                        ctx.set(header, 'cache-memory-dedup');
                        ctx.type = 'image/webp';
                        ctx.body = outputBuffer;
                        return;
                    } catch (e) {
                        // If the pending generation failed, fall through to try again
                    }
                }

                const ext = path.extname(fileSource).replace('.', '').toLowerCase();

                // Create the generation task
                const generationTask = (async () => {
                    const outputBuffer = await enqueue(async () => {
                        const ffmpegPath = api.getConfig('ffmpeg_path') || 'ffmpeg';
                        const ffprobePath = getFFprobePath(ffmpegPath);

                        // 1. Check for Embedded Cover Art (Audio & Video)
                        if (MEDIA_WITH_COVERS.includes(ext)) {
                            try {
                                const streamIndex = await getAttachedPictureStreamIndex(fileSource, ffprobePath);
                                
                                if (streamIndex !== null) {
                                    ctx.set(header, 'ffmpeg-extracted-cover');
                                    const coverBuffer = await extractEmbeddedThumbnail(fileSource, streamIndex, ffmpegPath);
                                    
                                    // Convert to WebP using FFmpeg directly
                                    const finalBuffer = await convertImageToWebP(coverBuffer, w, h, quality);
                                    
                                    await fs.writeFile(cacheFile, finalBuffer);
                                    return finalBuffer;
                                }
                            } catch (e) {
                                console.debug(`Cover extraction failed/skipped for ${fileSource}:`, e.message);
                            }
                        }
						
						// 2. If Audio don't have cover.
						if (AUDIO_EXTS.includes(ext)) {
							ctx.status = 204; // No content (no thumbnail)
							return null;
						}

                        // 3. Fallback: Generate Animated Video Thumbnail
                        if (isVideo(ext)) {
                            ctx.set(header, 'ffmpeg-animated');
                            const buf = await generateAnimatedVideoThumbnail(fileSource, w, quality);
                            await fs.writeFile(cacheFile, buf);
                            return buf;
                        }

                        // 4. Animated GIF/WebP
                        if (['gif', 'webp'].includes(ext)) {
                            ctx.set(header, 'ffmpeg-gif-to-webp');
                            const buf = await generateAnimatedGifThumbnail(fileSource, w, quality);
                            await fs.writeFile(cacheFile, buf);
                            return buf;
                        }

                        // 5. Standard Image
                        if (size > 100 * 1024 * 1024) throw new Error("Image too large (>100MB)");

                        let sourceBuffer;
                        if (ctx.body && typeof ctx.body.pipe === 'function') {
                            sourceBuffer = await buffer(ctx.body);
                        } else {
                            sourceBuffer = await fs.readFile(fileSource);
                        }

                        if (!sourceBuffer || sourceBuffer.length === 0) throw new Error("Empty buffer");

                        ctx.set(header, 'image-generated-webp');
                        
                        const finalBuffer = await convertImageToWebP(sourceBuffer, w, h, quality);

                        await fs.writeFile(cacheFile, finalBuffer);
                        return finalBuffer;
                    });

                    return outputBuffer;
                })();

                inFlightRequests.set(cacheHash, generationTask);

                try {
                    const outputBuffer = await generationTask;
                    ctx.type = 'image/webp';
                    ctx.body = outputBuffer;
                } catch (e) {
                    console.error(`BetterThumbnails Error [${fileSource}]:`, e.message);
                    ctx.status = 500;
                    ctx.body = e.message;
                } finally {
                    inFlightRequests.delete(cacheHash);
                }
            };
        }
    };

    function convertImageToWebP(imageBuffer, width, height, quality) {
        return new Promise((resolve, reject) => {
            const os = require('os');
            const ffmpegPath = api.getConfig('ffmpeg_path') || 'ffmpeg';
            const tmpInput = path.join(os.tmpdir(), `input-${Date.now()}-${Math.random().toString(36).slice(2)}`);
            const tmpOutput = path.join(os.tmpdir(), `output-${Date.now()}-${Math.random().toString(36).slice(2)}.webp`);

            // Write input buffer to temp file
            fs.writeFile(tmpInput, imageBuffer).then(() => {
                const args = [
                    '-i', tmpInput,
                    '-vf', `scale='min(${width},iw)':'min(${height},ih)':force_original_aspect_ratio=decrease`,
                    '-c:v', 'libwebp',
                    '-q:v', quality.toString(),
                    '-y',
                    tmpOutput
                ];

                const proc = spawn(ffmpegPath, args);
                const stderrChunks = [];

                proc.stderr.on('data', chunk => stderrChunks.push(chunk));
                
                proc.on('error', err => {
                    fs.unlink(tmpInput).catch(() => {});
                    fs.unlink(tmpOutput).catch(() => {});
                    reject(err);
                });

                proc.on('exit', async (code) => {
                    if (code !== 0) {
                        const stderr = Buffer.concat(stderrChunks).toString();
                        fs.unlink(tmpInput).catch(() => {});
                        fs.unlink(tmpOutput).catch(() => {});
                        return reject(new Error(`FFmpeg WebP conversion failed (${code}): ${stderr}`));
                    }

                    try {
                        const webpBuffer = await fs.readFile(tmpOutput);
                        await fs.unlink(tmpInput).catch(() => {});
                        await fs.unlink(tmpOutput).catch(() => {});
                        
                        if (webpBuffer.length === 0) return reject(new Error("FFmpeg produced empty WebP"));
                        resolve(webpBuffer);
                    } catch (err) {
                        reject(new Error(`Failed to read WebP output: ${err.message}`));
                    }
                });
            }).catch(err => reject(new Error(`Failed to write temp input: ${err.message}`)));
        });
    }

    async function generateAnimatedVideoThumbnail(filePath, width, quality) {
        const ffmpegPath = api.getConfig('ffmpeg_path') || 'ffmpeg';
        const ffprobePath = getFFprobePath(ffmpegPath);
        const os = require('os');

        const duration = await getVideoDuration(filePath, ffprobePath);

        let segments = [];
        if (duration < 5) {
            segments = [{ start: 0, duration: Math.max(1, duration) }];
        } else {
            segments = [
                { start: Math.min(2, duration - 1), duration: 1 },
                { start: duration * 0.15, duration: 1 },
                { start: duration * 0.30, duration: 1 },
                { start: duration * 0.45, duration: 1 },
                { start: duration * 0.60, duration: 1 }
            ];
        }

        const tmpFile = path.join(os.tmpdir(), `ffmpeg-tmp-${Date.now()}-${Math.random().toString(36).slice(2)}.webp`);

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
                '-y',
                tmpFile
            );

            const proc = spawn(ffmpegPath, args);
            const stderrChunks = [];

            proc.stderr.on('data', chunk => stderrChunks.push(chunk));
            
            proc.on('error', err => reject(err));
            proc.on('exit', async (code) => {
                if (code !== 0) {
                    const stderr = Buffer.concat(stderrChunks).toString();
                    fs.unlink(tmpFile).catch(() => {});
                    return reject(new Error(`FFmpeg animated export failed (Code ${code}). Stderr: ${stderr}`));
                }
                
                try {
                    const fullBuffer = await fs.readFile(tmpFile);
                    await fs.unlink(tmpFile).catch(() => {});
                    
                    if (fullBuffer.length === 0) return reject(new Error("FFmpeg produced an empty WebP output"));
                    resolve(fullBuffer);
                } catch (err) {
                    reject(new Error(`Failed to read temporary WebP file: ${err.message}`));
                }
            });
        });
    }

    async function generateAnimatedGifThumbnail(filePath, width, quality) {
        const ffmpegPath = api.getConfig('ffmpeg_path') || 'ffmpeg';
        const os = require('os');
        const tmpFile = path.join(os.tmpdir(), `ffmpeg-gif-${Date.now()}-${Math.random().toString(36).slice(2)}.webp`);

        return new Promise((resolve, reject) => {
            const args = [
                '-i', filePath,
                '-vf', `fps=10,scale='min(${width}\\,iw)':-2`,
                '-c:v', 'libwebp',
                '-loop', '0',
                '-q:v', quality.toString(),
                '-y',
                tmpFile
            ];

            const proc = spawn(ffmpegPath, args);
            const stderrChunks = [];

            proc.stderr.on('data', chunk => stderrChunks.push(chunk));
            proc.on('error', err => reject(err));
            proc.on('exit', async (code) => {
                if (code !== 0) {
                    const stderr = Buffer.concat(stderrChunks).toString();
                    fs.unlink(tmpFile).catch(() => {});
                    return reject(new Error(`FFmpeg GIF conversion failed (${code}): ${stderr}`));
                }

                try {
                    const fullBuffer = await fs.readFile(tmpFile);
                    await fs.unlink(tmpFile).catch(() => {});
                    if (fullBuffer.length === 0) return reject(new Error("FFmpeg produced empty WebP"));
                    resolve(fullBuffer);
                } catch (err) {
                    reject(new Error(`Failed to read WebP: ${err.message}`));
                }
            });
        });
    }

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
        const dir = path.dirname(ffmpegPath);
        const ext = path.extname(ffmpegPath);
        const name = path.basename(ffmpegPath, ext);
        
        if (name.toLowerCase() === 'ffmpeg') {
            return path.join(dir, 'ffprobe' + ext);
        }
        return 'ffprobe';
    }

    function getAttachedPictureStreamIndex(filePath, ffprobePath) {
        return new Promise((resolve, reject) => {
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
            const args = [
                '-i', filePath,
                '-map', `0:${streamIndex}`,
                '-c:v', 'copy',
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
