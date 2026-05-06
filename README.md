# Better Thumbnails Mod Plugin for HFS - V11

This is a **"FORK"** of the original PLUGIN, and very some of the changes were made **with an AI Agent**.

- PLEASE, **DON'T USE IT WITH THE ORIGINAL "Thumbnails" PLUGIN ENABLED!** It's already made to work same as the original plugin. Having it enabled will make every "animated webp" **static**. 🥲
- It's main funtionality is supposed to **bypass** "Sharp" plugin too, so it's **not** necesary, but it **needs** external depencies as **"FFmpeg"** & **"LibreOffice"**.

Replace standard browser-based thumbnails with high-performance, server-side generated **static** and **animated** "webp" previews.
The "cache-storage" is repaired and uses **SHA256**. It make animated thumbnails of GIF/WEBP images. And now, it extracts "covers" from music files, and every type of document files too!

The "V11" version was "re-made" with "Security" in Mind - The code is presented "as is". There are still some security flaws that CAN be handled just by "good configurations" and "good sourcing". What i mean with this, I'm not responsible of **"the files uploaded into your server"** that this plugin **"CAN open automaticlly"**. Be aware!

## 🌟 Capabilities

This plugin solves the "loading lag" caused by generating thumbnails in the browser, especially for video files.

*   **⚡ Zero-Lag Frontend**: Generates **animated images** of videos on the server. Your browser downloads tiny WebP images instead of decoding massive video files.
*   **🎥 Video Frame Extraction**: Uses **FFmpeg** to extract "some segments" from valid video files and shows a nice animated thumbnail.
*   **🕸️ WebP Format**: Serves next-gen **WebP** images for better quality and file sizes compared to "GIF", saving bandwidth.
*   **🔒 Concurrency Control**: Built-in **Task Queue** limits the number of parallel FFmpeg processes to prevent server CPU overload (Configurable).
*   **💾 File-Based Caching**: Persists now correctly, generated thumbnails to `~/.hfs/plugins/better-thumbnails-mod/storage`, keeping the main database clean and improving load speeds.
*   **🛠️ Extended Support**: Native frame extraction for `mp4`, `mkv`, `avi`, `mov`, `wmv`, `flv`, `webm`, `ts`, `m4v`, `mp3`, `aac`, `flac`, `m4a`, `ogg`, `wav`, `opus`, `oga`, `wma`, `pdf`, `doc`, `docx`, `ppt`, `pptx`, `xls`, `xlsx`, `odt`, `ods`, `odp`.

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

1.  **Install FFmpeg**: Ensure [FFmpeg](https://ffmpeg.org/download.html) is on your system! You can extract it where "HFS" is. It **needs "ffprobe"** so unzip the full package!
2.  **Install LibreOffice** (optional): Ensure [LibreOffice](https://libreoffice.org/download.html) is installed on your system too! It's used for the document thumbnail generation.
3.  **Link Paths**: In **Admin Panel > Plugins > better-thumbnails-mod**::
      - Set the **FFmpeg Executable Path** to the location of your `ffmpeg.exe` + `ffprobe.exe` (e.g. `C:\ffmpeg\bin\ffmpeg.exe`).
      - (Optional) Set the **LibreOffice Executable Path** to the the location of your `soffice.exe` (e.g. C:/Program Files/LibreOffice/program/soffice.exe).
4. **Optimize Performance**: If you have a powerful server, increase **Max Concurrent Generations** to `6-8` for faster bulk generation. On weaker VPS/Pi, keep it at `2-3`.
5. **Animated Generation can be CPU intensive!** Care of this!

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
| **Max Concurrent Generations** | Limit parallel FFmpeg processes. Prevents CPU spikes during folder scans. | `3` |
| **FFmpeg Executable Path** | **Required**. Absolute path to `ffmpeg` binary. | *Empty* |
| **LibreOffice Executable Path** | **Optional**. Absolute path to `soffice` binary. | *Empty* |
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
    *   **Audio**: `FFmpeg` extracts cover -> `FFmpeg` Reduces Frame into WEBP.
    *   **Documents**: `LibreOffice` extracts front page into image into a Temp Save -> `FFmpeg` Reduces Frame into WEBP -> Deletes Temps.
    *   **Video**: `FFmpeg` extracts a 5 seconds intro + 2 seconds of scenes from the 20%, and 40% into a Temp Save -> `FFmpeg` Concats Frames into an animated WEBP -> Deletes Temps.
6.  **Finalize**: Writes to disk cache and streams to client.

### Dependencies
*   **[FFmpeg](https://ffmpeg.org/)**: The universal multimedia framework.
*   **[LibreOffice](https://libreoffice.org/)**: The free office suite.
---

## 🏆 Credits

*   **[hfs-thumbnails](https://github.com/rejetto/thumbnails)**: Thanks to @rejetto for the original code of hfs-thumbnails this plugin is improved upon.
*   **[VenB304/hfs-better-thumbnails](https://github.com/VenB304/hfs-better-thumbnails)**: Thanks for the original work.
