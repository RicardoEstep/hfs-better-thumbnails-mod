/**
 * Better Thumbnails Mod Frontend
 * 
 * Credits:
 * - Based on 'thumbnails' frontend by Rejetto (https://github.com/rejetto/thumbnails)
 * - "VenB304" for it's first original version.
 */
'use strict'; {
    const { h, t } = HFS;
    const config = HFS.getPluginConfig();

    // List of video and audio extensions we support via FFmpeg
    // We treat them exactly like images now, because the server does the heavy lifting.
    const VIDEO_EXTS = ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'ts', 'm4v'];
	const AUDIO_EXTS = ['mp3', 'aac', 'flac', 'm4a', 'ogg', 'wav', 'opus', 'oga', 'wma'];

    const isSupported = (entry) => {
        if (!entry) return false;
        const ext = entry.ext.toLowerCase();

        // Server-side calculated support flag or Standard Image Exts, Video Exts or Audio Exts.
        return entry._th
            || ['jpg', 'jpeg', 'png', 'webp', 'tiff', 'tif', 'gif', 'avif', 'svg'].includes(ext)
            || VIDEO_EXTS.includes(ext)
			|| AUDIO_EXTS.includes(ext);
    };

    // Component to properly handle hooks
    function BetterThumbnailIcon({ entry }) {
        // Use ref to reset 'Instant-Show' binding
        const domRef = HFS.React.useRef(null);

        // Check if this is a video or audio.
        // For videos or audio, Instant-Show binds to the DEFAULT 'span.icon' immediately.
        // When we mount and replace it with OUR 'span.icon', the listener is lost (zombie).
        // We must force Instant-Show to find us.
        //
        // For IMAGES, Instant-Show waits for 'img.thumbnail'. When we execute, it finds us
        // and binds correctly. If we reset bind here, it would double-bind (rendering bug).
        const isVideo = VIDEO_EXTS.includes(entry.ext.toLowerCase());
		const isAudio = AUDIO_EXTS.includes(entry.ext.toLowerCase());

        HFS.React.useEffect(() => {
            if ((isVideo || isAudio) && domRef.current) {
                const li = domRef.current.closest('li.file');
                if (li && li.dataset.bound) {
                    // Reset the bind flag so Instant-Show finds the NEW icon
                    delete li.dataset.bound;

                    // Trigger MutationObserver
                    const dummy = document.createElement('i');
                    dummy.style.display = 'none';
                    li.appendChild(dummy);
                    setTimeout(() => dummy.remove(), 0);
                }
            }
        }, []);

        return h('span', { className: 'icon', ref: domRef },
            h(ImgFallback, {
                fallback: () => entry.getDefaultIcon(),
                tag: 'img',
                props: {
                    src: entry.uri + '?get=thumb',
                    className: 'thumbnail', // 'thumbnail' class needed for Instant-Show to find it
                    loading: 'lazy',
                    alt: entry.name,
                    // FIX: Use 'contain' to show full image, 'auto' size to respect aspect ratio
                    style: { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: '4px' },
                    onMouseLeave() {
                        const preview = document.getElementById('thumbnailsPreview');
                        if (preview) preview.innerHTML = '';
                    },
                    onMouseEnter(ev) {
                        if (!ev.target.closest('.dir')) return;
                        if (!HFS.state.tile_size) {
                            // List mode preview
                            const preview = document.getElementById('thumbnailsPreview');
                            if (preview) preview.innerHTML = `<img src="${entry.uri}?get=thumb" class="preview-large"/>`;
                        }
                    },
                }
            })
        );
    }

    // Override the default entry icon with our thumbnail
    HFS.onEvent('entryIcon', ({ entry }) => {
        if (!isSupported(entry)) return;
        return h(BetterThumbnailIcon, { entry });
    });

    // Simple container for list-view hover preview
    HFS.onEvent('afterList', () =>
        "<div id='thumbnailsPreview'></div>" +
        "<style>" +
        " #thumbnailsPreview { position: fixed; bottom: 10px; right: 10px; z-index: 100; pointer-events: none; }" +
        " #thumbnailsPreview img.preview-large { max-width: 300px; max-height: 300px; border: 2px solid #fff; box-shadow: 0 0 10px rgba(0,0,0,0.5); background: #000; }" +
        " .icon.thumbnail { object-fit: contain; border-radius: 4px; }" +
        "</style>"
    );

    function ImgFallback({ fallback, tag = 'img', props }) {
        const [err, setErr] = HFS.React.useState(false);
        if (err) return fallback ? h(fallback) : null;

        return h(tag, Object.assign({}, props, {
            onError: () => setErr(true)
        }));
    }

    // Add "Tiles Mode" button to file menu if not already there
    HFS.onEvent('fileMenu', ({ entry }) => {
        if (!HFS.state.tile_size && isSupported(entry)) {
            return [{
                icon: '⊞',
                label: t("Enable tiles mode"),
                onClick() {
                    HFS.state.tile_size = 10; // Enable tiles
                    HFS.dialogLib.toast(t('Switched to Tiles Mode'));
                }
            }];
        }
    });

}
