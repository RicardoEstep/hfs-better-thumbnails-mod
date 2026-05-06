/**
 * Better Thumbnails Mod Plugin
 * * Credits:
 * - Based on 'thumbnails' plugin by Rejetto (https://github.com/rejetto/thumbnails)
 * - FFmpeg integration inspired by 'videojs-player' and 'unsupported-videos'
 * - "VenB304" for its first original version.
 */

exports.version = 11;
exports.description = "High-performance thumbnails generation using FFmpeg. Generates images on server preventing frontend lag.";
exports.apiRequired = 12.0;
exports.repo = "RicardoEstep/hfs-better-thumbnails-mod";
exports.frontend_js = 'main.js';

exports.config = {
    // --- Performance & Quality Settings ---
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
        defaultValue: 3,
        min: 1, max: 32,
        label: "Max Concurrent Generations",
        helperText: "Maximum number of parallel thumbnails to generate. Higher = more CPU usage.",
        xs: 6
    },
    max_image_size: {
        type: 'number',
        defaultValue: 100,
        min: 1, max: 1000,
        label: "Max Image Size (MB)",
        helperText: "Maximum file size to process as image thumbnail. Larger files are skipped.",
        unit: 'MB',
        xs: 6
    },
    // --- Path Settings ---
    ffmpeg_path: {
        type: 'real_path',
        fileMask: 'ffmpeg*',
        label: "FFmpeg Executable Path (Required)",
        helperText: "Path to ffmpeg binary (e.g. C:/ffmpeg/bin/ffmpeg.exe).",
        xs: 12
    },
    soffice_path: {
        type: 'real_path',
        fileMask: '*soffice*',
        label: "LibreOffice Path (soffice)",
        helperText: "Path to LibreOffice 'soffice' Binary (e.g. C:/Program Files/LibreOffice/program/soffice.exe).",
        xs: 12
    },
    // --- Maintenance ---
    clear_cache: {
        type: 'boolean',
        defaultValue: false,
        label: "Clear Thumbnail Cache",
        helperText: "Switch this ON and click 'Apply/Save' to permanently delete the Generated Cache. It will turn itself Off automatically.",
        xs: 12
    },
    log: { type: 'boolean', defaultValue: false, label: "Log thumbnail generation" },
};


exports.init = async api => {
    const { createReadStream, promises: fs } = api.require('fs');
    const path = api.require('path');
    const crypto = api.require('crypto');    // For SHA256 hashing.
    const { buffer } = api.require('node:stream/consumers');
    const { spawn } = api.require('child_process');
    const os = api.require('os');

    // --- CONSTANTS ---
    const header = 'x-thumbnail';
    const VIDEO_EXTS = ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'ts', 'm4v'];
    const AUDIO_EXTS = ['mp3', 'aac', 'flac', 'm4a', 'ogg', 'wav', 'opus', 'oga', 'wma'];
    const MEDIA_WITH_COVERS = [...VIDEO_EXTS, ...AUDIO_EXTS];
    const DOC_EXTS = ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'odt', 'ods', 'odp'];
    const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'tiff', 'tif', 'gif', 'avif', 'svg'];
    const MAX_QUEUE_SIZE = 50;    // FIFO Max Queue, for Security
    const FFPROBE_TIMEOUT = 5000; // ms
    const FFMPEG_TIMEOUT = 30000; // ms
    const SOFFICE_TIMEOUT = 15000; // ms

    // Setup Cache Directory
    const cacheDir = path.join(api.storageDir, 'thumbnails');
    await fs.mkdir(cacheDir, { recursive: true }).catch(err => {
        console.error("BetterThumbnails: Failed to create cache dir", err);
    });

    // Listen for the "Cleaning Cache" Trigger
    api.subscribeConfig('clear_cache', async (value) => {
        // Executes when the user flips it to "TRUE"
        if (value === true) {
            try {
                // Remove content and recreate the directory again
                await fs.rm(cacheDir, { recursive: true, force: true });
                await fs.mkdir(cacheDir, { recursive: true });
                
                api.log("BetterThumbnailsMod: Cache cleared manually via settings.");
            } catch (e) {
                api.log("BetterThumbnailsMod: Failed to clear cache: " + e.message);
            }

            // Immediately reset back to "false" after use.
            api.setConfig('clear_cache', false);
        }
    });

    // Concurrency Queue
    const queue = [];
    let active = 0;
    const inFlightRequests = new Map();

    // Execute queued tasks with concurrency control
    const runQueue = () => {
        const limit = api.getConfig('concurrency_limit') || 3;
        if (active >= limit || queue.length === 0) return;

        active++;
        const { task, resolve, reject } = queue.shift();

        task()
            .then(resolve)
            .catch(reject)
            .finally(() => {
                active--;
                runQueue();
            });
    };

    // Add task to queue with size limit
    const enqueue = (task) => new Promise((resolve, reject) => {
        if (queue.length >= MAX_QUEUE_SIZE) {
            return reject(new Error("Thumbnail queue is full. Server too busy."));
        }
        queue.push({ task, resolve, reject });
        runQueue();
    });

    // Generate safe temporary file path with random identifier
    const getTempPath = (prefix, ext = '') => {
        const randomHex = crypto.randomBytes(8).toString('hex');
        return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${randomHex}${ext}`);
    };

    // Helper to safely cleanup temp files
    const cleanupTempFile = async (filePath) => {
        try {
            await fs.unlink(filePath);
        } catch (e) {
            // Silent - file may not exist
        }
    };

    // Helper to safely cleanup multiple temp files
    const cleanupTempFiles = async (filePaths) => {
        await Promise.all(filePaths.map(cleanupTempFile));
    };

    const isVideo = (ext) => VIDEO_EXTS.includes(ext);
    const isAudio = (ext) => AUDIO_EXTS.includes(ext);
    const isDoc = (ext) => DOC_EXTS.includes(ext);
    const isImage = (ext) => IMAGE_EXTS.includes(ext);

    // Plugin Function.
    return {
        middleware(ctx) {
            if (ctx.query.get !== 'thumb') return;

            ctx.state.considerAsGui = true;
            ctx.state.download_counter_ignore = true;

            return async () => {
                if (!ctx.body && ctx.status !== 200) return;    // Only process if file exists
                if (ctx.status === 304) return;    // Not modified

                if (!api.getConfig('log')) ctx.state.dontLog = true;

                const { fileSource, fileStats } = ctx.state;
                if (!fileSource) return;

                const { size, mtimeMs: ts, birthtimeMs } = fileStats || {};
                const fileTs = ts || birthtimeMs;
                const quality = api.getConfig('quality');
                const pixels = api.getConfig('pixels');

                // Security: Validate and clamp dimensions
                const rawW = parseInt(ctx.query.w, 10);
                const rawH = parseInt(ctx.query.h, 10);
                const w = Math.max(10, Math.min(2000, isNaN(rawW) ? pixels : rawW));
                const h = Math.max(10, Math.min(2000, isNaN(rawH) ? w : rawH));

                // Calculate Cache Key - includes ALL parameters that affect output
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

                // Fallback: Check In-Flight Requests (Memory Deduplication)
                // IMPORTANT: Only use in-flight cache if first request succeeded!
                if (inFlightRequests.has(cacheHash)) {
                    try {
                        const result = await inFlightRequests.get(cacheHash);
                        // Check if result is an error
                        if (result instanceof Error) {
                            throw result;
                        }
                        ctx.set(header, 'cache-memory-dedup');
                        ctx.type = 'image/webp';
                        ctx.body = result;
                        return;
                    } catch (e) {
                        // Fall through to try again - first request failed, let's retry
                        inFlightRequests.delete(cacheHash);
                    }
                }

                // Generate (Queued)
                const ext = path.extname(fileSource).replace('.', '').toLowerCase();

                // Create the "Generation Task".
                const generationTask = (async () => {
                    try {
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
                                    // Log but continue to fallback (e.g., no cover art)
                                    if (api.getConfig('log')) {
                                        console.debug(`Cover extraction failed/skipped for ${fileSource}:`, e.message);
                                    }
                                }
                            }

                            // 2. If Audio Files don't have any Cover.
                            if (AUDIO_EXTS.includes(ext)) {
                                ctx.status = 204; // No content.
                                return null;
                            }

                            // 3. Generate Animated Video Thumbnail.
                            if (isVideo(ext)) {
                                ctx.set(header, 'ffmpeg-animated');
                                const buf = await generateAnimatedVideoThumbnail(fileSource, w, quality);
                                await fs.writeFile(cacheFile, buf);
                                return buf;
                            }

                            // 4. Animated GIF/WebP.
                            if (['gif', 'webp'].includes(ext)) {
                                ctx.set(header, 'ffmpeg-gif-to-webp');
                                const buf = await generateAnimatedGifThumbnail(fileSource, w, quality);
                                await fs.writeFile(cacheFile, buf);
                                return buf;
                            }

                            // 5. Document Thumbnails Handler.
                            if (DOC_EXTS.includes(ext)) {
                                const sofficePath = api.getConfig('soffice_path');
                                if (!sofficePath) {
                                    ctx.status = 204;    // If not PATH, return "empty".
                                    return null;
                                }

                                ctx.set(header, 'office-to-webp');
                                
                                // 1. Extract first page using LibreOffice.
                                const rawImageBuffer = await extractDocumentThumbnail(fileSource, sofficePath, cacheHash);
                                
                                // 2. Convert to WebP using existing image function.
                                const finalBuffer = await convertImageToWebP(rawImageBuffer, w, h, quality);
                                
                                await fs.writeFile(cacheFile, finalBuffer);
                                return finalBuffer;
                            }

                            // 6. Standard Images.
                            const maxSizeBytes = (api.getConfig('max_image_size') || 100) * 1024 * 1024;
                            if (size > maxSizeBytes) {
                                throw new Error(`Image too large (>${maxSizeBytes / 1024 / 1024}MB)`);
                            }

                            if (!isImage(ext)) {
                                ctx.status = 204; // Unsupported format
                                return null;
                            }

                            ctx.set(header, 'image-generated-webp');

                            let finalBuffer;
                            if (!ctx.body || typeof ctx.body.pipe !== 'function') {
                                // File exists on disk: let FFmpeg read it directly (Saves RAM!)
                                finalBuffer = await convertFileToWebP(fileSource, w, h, quality, ffmpegPath);
                            } else {
                                // File is an active stream (not fully on disk): buffer it first
                                const sourceBuffer = await buffer(ctx.body);
                                if (!sourceBuffer || sourceBuffer.length === 0) throw new Error("Empty buffer");
                                finalBuffer = await convertImageToWebP(sourceBuffer, w, h, quality);
                            }

                            await fs.writeFile(cacheFile, finalBuffer);
                            return finalBuffer;
                        });
                        
                        return outputBuffer;
                    } catch (err) {
                        // Store error so in-flight requests also fail appropriately
                        throw err;
                    }
                })();

                inFlightRequests.set(cacheHash, generationTask);

                try {
                    const outputBuffer = await generationTask;
                    if (outputBuffer === null) {
                        // Already handled (204 No Content)
                        return;
                    }
                    ctx.type = 'image/webp';
                    ctx.body = outputBuffer;
                } catch (e) {
                    console.error(`BetterThumbnailsMod Error [${fileSource}]:`, e.message);
                    ctx.status = e.message.includes("queue is full") ? 503 : 500;
                    ctx.body = e.message;
                } finally {
                    inFlightRequests.delete(cacheHash);
                }
            };
        }
    };

    // Convert image buffer to WebP with specified dimensions and quality
    function convertImageToWebP(imageBuffer, width, height, quality) {
        return new Promise((resolve, reject) => {
            const ffmpegPath = api.getConfig('ffmpeg_path') || 'ffmpeg';
            const tmpInput = getTempPath('input');
            const tmpOutput = getTempPath('output', '.webp');

            fs.writeFile(tmpInput, imageBuffer)
                .then(() => {
                    runFFmpegConversion(ffmpegPath, tmpInput, tmpOutput, width, height, quality)
                        .then(resolve)
                        .catch(reject)
                        .finally(() => cleanupTempFile(tmpInput));
                })
                .catch(err => {
                    cleanupTempFile(tmpInput); // cleanup on failure
                    reject(new Error(`Failed to write temp input: ${err.message}`));
                });
        });
    }
    
    // Convert file directly to WebP (keeps large files off RAM)
    function convertFileToWebP(filePath, width, height, quality, ffmpegPath) {
        const tmpOutput = getTempPath('output', '.webp');
        return runFFmpegConversion(ffmpegPath, filePath, tmpOutput, width, height, quality);
    }
    
    // Core FFmpeg conversion with proper error handling and cleanup
    function runFFmpegConversion(ffmpegPath, inputPath, outputPath, width, height, quality) {
        return new Promise((resolve, reject) => {
            const args = [
                '-i', inputPath,
                '-vf', `scale='min(${width},iw)':'min(${height},ih)':force_original_aspect_ratio=decrease`,
                '-c:v', 'libwebp',
                '-q:v', quality.toString(),
                '-y',
                outputPath
            ];

            const proc = spawn(ffmpegPath, args);
            const stderrChunks = [];
            let timedOut = false;

            // Timeout protection
            const timeout = setTimeout(() => {
                timedOut = true;
                proc.kill();
            }, FFMPEG_TIMEOUT);

            proc.stderr.on('data', chunk => stderrChunks.push(chunk));
            
            proc.on('error', err => {
                clearTimeout(timeout);
                cleanupTempFile(outputPath);
                reject(err);
            });

            proc.on('exit', async (code, signal) => {
                clearTimeout(timeout);
                
                if (timedOut) {
                    await cleanupTempFile(outputPath);
                    return reject(new Error(`FFmpeg conversion timed out (>${FFMPEG_TIMEOUT}ms)`));
                }

                if (code !== 0) {
                    const stderr = Buffer.concat(stderrChunks).toString();
                    await cleanupTempFile(outputPath);
                    return reject(new Error(`FFmpeg WebP conversion failed (${code}): ${stderr}`));
                }

                try {
                    const webpBuffer = await fs.readFile(outputPath);
                    await cleanupTempFile(outputPath);
                    
                    if (webpBuffer.length === 0) {
                        return reject(new Error("FFmpeg produced empty WebP"));
                    }
                    resolve(webpBuffer);
                } catch (err) {
                    await cleanupTempFile(outputPath);
                    reject(new Error(`Failed to read WebP output: ${err.message}`));
                }
            });
        });
    }

    // Generate animated video thumbnail with intelligent frame selection
    async function generateAnimatedVideoThumbnail(filePath, width, quality) {
        const ffmpegPath = api.getConfig('ffmpeg_path') || 'ffmpeg';
        const ffprobePath = getFFprobePath(ffmpegPath);

        const duration = await getVideoDuration(filePath, ffprobePath);
        if (duration <= 0) {
            throw new Error("Could not determine video duration");
        }

        // Intelligent segment selection based on video length
        let segments = [];
        if (duration < 6) {
            // Videos less than 6 seconds - Show full length
            segments = [{ start: 0, duration: Math.min(duration, 5) }];
        }
        else if (duration < 30) {
            // Videos less than 30 seconds - First 5 seconds
            segments = [{ start: 0, duration: 5 }];
        }
        else {
            // Longer videos - Capture key moments
            segments = [
                { start: 0, duration: 4 },              // Opening
                { start: Math.max(0, duration * 0.20), duration: 2 }, // 20% mark
                { start: Math.max(0, duration * 0.40), duration: 2 }  // 40% mark
            ];
        }

        const tmpFile = getTempPath('ffmpeg-animated', '.webp');

        return new Promise((resolve, reject) => {
            const args = [];
            
            // Build input arguments for each segment
            segments.forEach(seg => {
                args.push('-ss', seg.start.toFixed(2), '-t', seg.duration.toFixed(2), '-i', filePath);
            });

            // Build filter string
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
            let timedOut = false;

            const timeout = setTimeout(() => {
                timedOut = true;
                proc.kill();
            }, FFMPEG_TIMEOUT);

            proc.stderr.on('data', chunk => stderrChunks.push(chunk));
            
            proc.on('error', err => {
                clearTimeout(timeout);
                cleanupTempFile(tmpFile);
                reject(err);
            });

            proc.on('exit', async (code) => {
                clearTimeout(timeout);

                if (timedOut) {
                    await cleanupTempFile(tmpFile);
                    return reject(new Error(`Video animation timed out (>${FFMPEG_TIMEOUT}ms)`));
                }

                if (code !== 0) {
                    const stderr = Buffer.concat(stderrChunks).toString();
                    await cleanupTempFile(tmpFile);
                    return reject(new Error(`FFmpeg animated export failed (${code}): ${stderr}`));
                }
                
                try {
                    const fullBuffer = await fs.readFile(tmpFile);
                    await cleanupTempFile(tmpFile);
                    if (fullBuffer.length === 0) {
                        return reject(new Error("FFmpeg produced empty animated WebP"));
                    }
                    resolve(fullBuffer);
                } catch (err) {
                    await cleanupTempFile(tmpFile);
                    reject(new Error(`Failed to read temporary WebP file: ${err.message}`));
                }
            });
        });
    }

    // Convert GIF/WebP animation to optimized WebP format
    async function generateAnimatedGifThumbnail(filePath, width, quality) {
        const ffmpegPath = api.getConfig('ffmpeg_path') || 'ffmpeg';
        const tmpFile = getTempPath('ffmpeg-gif', '.webp');

        return new Promise((resolve, reject) => {
            const args = [
                '-i', filePath,
                '-vf', `fps=10,scale='min(${width},iw)':-2`,
                '-c:v', 'libwebp',
                '-loop', '0',
                '-q:v', quality.toString(),
                '-y',
                tmpFile
            ];

            const proc = spawn(ffmpegPath, args);
            const stderrChunks = [];
            let timedOut = false;

            const timeout = setTimeout(() => {
                timedOut = true;
                proc.kill();
            }, FFMPEG_TIMEOUT);

            proc.stderr.on('data', chunk => stderrChunks.push(chunk));
            
            proc.on('error', err => {
                clearTimeout(timeout);
                cleanupTempFile(tmpFile);
                reject(err);
            });

            proc.on('exit', async (code) => {
                clearTimeout(timeout);

                if (timedOut) {
                    await cleanupTempFile(tmpFile);
                    return reject(new Error(`GIF conversion timed out (>${FFMPEG_TIMEOUT}ms)`));
                }

                if (code !== 0) {
                    const stderr = Buffer.concat(stderrChunks).toString();
                    await cleanupTempFile(tmpFile);
                    return reject(new Error(`FFmpeg GIF conversion failed (${code}): ${stderr}`));
                }

                try {
                    const fullBuffer = await fs.readFile(tmpFile);
                    await cleanupTempFile(tmpFile);
                    if (fullBuffer.length === 0) {
                        return reject(new Error("FFmpeg produced empty WebP from GIF"));
                    }
                    resolve(fullBuffer);
                } catch (err) {
                    await cleanupTempFile(tmpFile);
                    reject(new Error(`Failed to read WebP: ${err.message}`));
                }
            });
        });
    }

    // Extract first page of document as image using LibreOffice
    async function extractDocumentThumbnail(filePath, sofficePath, cacheHash) {
        const tmpDir = os.tmpdir();
        
        // Create UNIQUE temp directory using the cache hash (same hash that will identify the final cached file)
        const uniqueTmpDir = path.join(tmpDir, `hfs-doc-${cacheHash}`);
        
        try {
            await fs.mkdir(uniqueTmpDir, { recursive: true });
        } catch (e) {
            return Promise.reject(new Error(`Failed to create temp directory: ${e.message}`));
        }

        // LibreOffice will create the PNG with the original document name
        const fileName = path.basename(filePath, path.extname(filePath));
        const expectedOutput = path.join(uniqueTmpDir, `${fileName}.png`);

        return new Promise((resolve, reject) => {
            const args = [
                '--headless',
                '--convert-to', 'png',
                '--outdir', uniqueTmpDir,  // ← Use unique subdirectory based on cache hash
                filePath
            ];

            const proc = spawn(sofficePath, args);
            let timedOut = false;

            const timeout = setTimeout(() => {
                timedOut = true;
                proc.kill();
            }, SOFFICE_TIMEOUT);
            
            proc.on('error', err => {
                clearTimeout(timeout);
                fs.rm(uniqueTmpDir, { recursive: true, force: true }).catch(() => {});
                reject(err);
            });

            proc.on('exit', async (code) => {
                clearTimeout(timeout);

                if (timedOut) {
                    await fs.rm(uniqueTmpDir, { recursive: true, force: true }).catch(() => {});
                    return reject(new Error(`LibreOffice conversion timed out (>${SOFFICE_TIMEOUT}ms)`));
                }

                if (code !== 0) {
                    await fs.rm(uniqueTmpDir, { recursive: true, force: true }).catch(() => {});
                    return reject(new Error(`LibreOffice failed with code ${code}`));
                }

                try {
                    const buffer = await fs.readFile(expectedOutput);
                    
                    // Cleanup the unique temp directory after reading
                    await fs.rm(uniqueTmpDir, { recursive: true, force: true }).catch(() => {});
                    
                    resolve(buffer);
                } catch (err) {
                    await fs.rm(uniqueTmpDir, { recursive: true, force: true }).catch(() => {});
                    reject(new Error(`Could not read document thumbnail: ${err.message}`));
                }
            });
        });
    }

    // Get video duration using ffprobe with proper error handling
    function getVideoDuration(filePath, ffprobePath) {
        return new Promise((resolve, reject) => {
            const args = [
                '-v', 'error',
                '-show_entries', 'format=duration',
                '-of', 'default=noprint_wrappers=1:nokey=1',
                filePath
            ];
            
            const proc = spawn(ffprobePath, args);
            let output = '';
            let timedOut = false;

            const timeout = setTimeout(() => {
                timedOut = true;
                proc.kill();
            }, FFPROBE_TIMEOUT);

            proc.stdout.on('data', chunk => output += chunk.toString());
            
            proc.on('error', err => {
                clearTimeout(timeout);
                // Don't resolve silently - let caller handle
                reject(new Error(`FFprobe error: ${err.message}`));
            });

            proc.on('exit', (code) => {
                clearTimeout(timeout);

                if (timedOut) {
                    return reject(new Error(`FFprobe timed out (>${FFPROBE_TIMEOUT}ms)`));
                }

                if (code !== 0) {
                    return reject(new Error(`FFprobe failed with code ${code}`));
                }

                const duration = parseFloat(output.trim());
                if (isNaN(duration) || duration <= 0) {
                    return reject(new Error("FFprobe returned invalid duration"));
                }
                resolve(duration);
            });
        });
    }

    // Derive ffprobe path from ffmpeg path. Assumes they're in the same directory with same extension
    function getFFprobePath(ffmpegPath) {
        const dir = path.dirname(ffmpegPath);
        const ext = path.extname(ffmpegPath);
        const name = path.basename(ffmpegPath, ext);
        
        if (name.toLowerCase() === 'ffmpeg') {
            return path.join(dir, 'ffprobe' + ext);
        }
        return 'ffprobe';
    }

    // Query ffprobe for attached picture stream (cover art)
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
            let timedOut = false;

            const timeout = setTimeout(() => {
                timedOut = true;
                proc.kill();
            }, FFPROBE_TIMEOUT);
            
            proc.stdout.on('data', chunk => chunks.push(chunk));
            
            proc.on('error', err => {
                clearTimeout(timeout);
                reject(err);
            });

            proc.on('exit', (code) => {
                clearTimeout(timeout);

                if (timedOut) {
                    return reject(new Error(`FFprobe timed out (>${FFPROBE_TIMEOUT}ms)`));
                }

                if (code !== 0) {
                    return reject(new Error(`ffprobe exited with code ${code}`));
                }
                
                try {
                    const output = Buffer.concat(chunks).toString();
                    const json = JSON.parse(output);
                    
                    if (json.streams && Array.isArray(json.streams)) {
                        for (const stream of json.streams) {
                            if (stream.disposition && stream.disposition.attached_pic === 1) {
                                return resolve(stream.index);
                            }
                        }
                    }
                    resolve(null); // No cover art found
                } catch (e) {
                    reject(new Error(`Failed to parse ffprobe output: ${e.message}`));
                }
            });
        });
    }

    // Extract embedded cover art image from media file
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
            let timedOut = false;

            const timeout = setTimeout(() => {
                timedOut = true;
                proc.kill();
            }, FFMPEG_TIMEOUT);

            proc.stdout.on('data', chunk => chunks.push(chunk));
            proc.stderr.on('data', chunk => stderrChunks.push(chunk));
            
            proc.on('error', err => {
                clearTimeout(timeout);
                reject(err);
            });

            proc.on('exit', (code) => {
                clearTimeout(timeout);

                if (timedOut) {
                    return reject(new Error(`Cover extraction timed out (>${FFMPEG_TIMEOUT}ms)`));
                }

                if (code !== 0) {
                    const stderr = Buffer.concat(stderrChunks).toString();
                    return reject(new Error(`FFmpeg extract failed with code ${code}: ${stderr}`));
                }

                const fullBuffer = Buffer.concat(chunks);
                if (fullBuffer.length === 0) {
                    return reject(new Error("FFmpeg extracted empty buffer"));
                }
                resolve(fullBuffer);
            });
        });
    }
};
