# Better Thumbnails Mod Plugin for HFS

This is a **"FORK"** of the original PLUGIN, and changes were made **with an AI Agent**.

- PLEASE DON'T USE IT WITH THE ORIGINAL "Thumbnails" PLUGIN ENABLED. It will do the same function, and will make every "animated webp" static.

Replace standard browser-based thumbnails with high-performance, server-side generated **animated** previews. Supports modern image formats (WebP) and live video frames.
It repairs too the "cache-storage" using **SHA256**, and now, it made thumbnails of GIF images too.

## 🌟 Capabilities

This plugin solves the "loading lag" caused by generating thumbnails in the browser, especially for video files.

*   **⚡ Zero-Lag Frontend**: Generates **animated images** on the server. Your browser downloads tiny WebP images instead of decoding massive video files.
*   **🎥 Video Frame Extraction**: Uses **FFmpeg** to extract "5 segments of 1 second" from valid video files (seeking past the intro black screen).
*   **🕸️ WebP Format**: Serves next-gen **WebP** images for better quality and file sizes compared to "GIF", saving bandwidth.
*   **🔒 Concurrency Control**: Built-in **Task Queue** limits the number of parallel FFmpeg processes to prevent server CPU overload (Configurable).
*   **💾 File-Based Caching**: Persists now correctly, generated thumbnails to `~/.hfs/plugins/better-thumbnails-mod/storage`, keeping the main database clean and improving load speeds.
*   **🛠️ Extended Support**: Native frame extraction for `mp4`, `mkv`, `avi`, `mov`, `wmv`, `flv`, `webm`, `ts`, and `m4v`.

---

## 🚀 Installation

### Option 1: Manual
1.  Download the `dist` folder from this repository.
2.  Place it inside your HFS `plugins` directory
3.  Rename `dist` folder to `better-thumbnails-mod`
4.  Restart HFS or reload plugins.

---

## ⚡ Quick Setup Guide

Get the most out of the plugin in 30 seconds:

1.  **Install FFmpeg**: Ensure [FFmpeg](https://ffmpeg.org/download.html) is installed on your system.
2.  **Link Path**: In **Admin Panel > Plugins > better-thumbnails**, set the **FFmpeg Executable Path** to the location of your `ffmpeg.exe` (e.g. `C:\ffmpeg\bin\ffmpeg.exe`).
3.  **Optimize Performance**: If you have a powerful server, increase **Max Concurrent Generations** to `8` for faster bulk generation. On weaker VPS/Pi, keep it at `2-4`.

---

## ⚙️ Configuration Guide

Settings are organized in **Admin Panel > Plugins > better-thumbnails-mod**.

### 1. General & Image
| Setting | Description | Default |
| :--- | :--- | :--- |
| **Pixels** | Max dimension (width/height) of the generated image. Images are resized to fit relative to this box. | `256` |
| **Quality** | WebP Compression Quality (1-100). Lower values reduce file size but may artifact. | `60` |

### 2. Performance & System
| Setting | Description | Default |
| :--- | :--- | :--- |
| **Max Concurrent Generations** | Limit parallel FFmpeg/Sharp processes. Prevents CPU spikes during folder scans. | `4` |
| **FFmpeg Executable Path** | **Required**. Absolute path to `ffmpeg` binary. | *Empty* |
| **Log Generation** | Print console messages for every generated thumbnail. Useful for debugging. | `Off` |

---

## 🛠️ Troubleshooting

### 1. Generation Issues
| Error/Event | Description | Solution(s) |
| :--- | :--- | :--- |
| **Thumbnails not showing** | General failure to load image. | 1. Check **FFmpeg Path**.<br>2. Clear browser cache.<br>3. Check `plugins/better-thumbnails-mod/storage` permissions. |
| **"Server Error" (500)** | Backend crash during generation. | Enable **Log Generation** to see the error. Usually a corrupt video file. |
| **Large Images Fail** | "Image too large (>100MB)" error. | Plugin strictly rejects source images >100MB to prevent RAM exhaustion. |

### 2. Performance
| Error/Event | Description | Solution(s) |
| :--- | :--- | :--- |
| **High CPU Usage** | Server fans spinning up. | Reduce **Max Concurrent Generations** to `1` or `2`. |
| **Slow Loading** | Thumbnails appear one by one slowly. | Normal on first visit. Second visit uses cached files (Instant). |

---

## 👨‍💻 Technical Details

### Architecture
This plugin works as an on-demand generation pipeline:

1.  **Intercept**: Listens for requests with `?get=thumb`.
2.  **Hash**: Calculates a **BETTER** unique SHA256* hash based on `Filename + Timestamp + Dimensions + Quality`.
3.  **Cache Lookup**: Checks `storage/thumbnails/[HASH].webp`.
    *   **Hit**: Serves file immediately (Zero CPU).
    *   **Miss**: Pushes task to **FIFO Queue**.
4.  **Worker Processing**:
    *   **Video**: `FFmpeg` seeks into "2s/15%/30%/45%/60% -> Temps Save -> Concats Frame into WEBP -> Deletes Temp Save.
5.  **Finalize**: Writes to disk cache and streams to client.

### Dependencies
*   **[FFmpeg](https://ffmpeg.org/)**: The universal multimedia framework.

---

## 🏆 Credits

*   **[hfs-thumbnails](https://github.com/rejetto/thumbnails)**: Thanks to @rejetto for the original code of hfs-thumbnails this plugin is improved upon.
*   **[VenB304/hfs-better-thumbnails](https://github.com/VenB304/hfs-better-thumbnails)**: Thanks for the original work.
