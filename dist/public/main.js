/**
 * Better Thumbnails Mod Frontend
 * * Credits:
 * - Based on 'thumbnails' frontend by Rejetto (https://github.com/rejetto/thumbnails)
 * - "VenB304" for its first original version.
 */
 
'use strict'; {
    const { h, t } = HFS;
    const config = HFS.getPluginConfig();

    // List of supported file extensions
    const VIDEO_EXTS = ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'ts', 'm4v'];
    const AUDIO_EXTS = ['mp3', 'aac', 'flac', 'm4a', 'ogg', 'wav', 'opus', 'oga', 'wma'];
    const DOC_EXTS = ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'odt', 'ods', 'odp'];
    const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'tiff', 'tif', 'gif', 'avif', 'svg'];

    // Determine if file type is supported for thumbnails
    const isSupported = (entry) => {
        if (!entry) return false;
        const ext = entry.ext.toLowerCase();

        // Check if server-side thumbnail is enabled OR file is in supported formats
        return entry._th
            || IMAGE_EXTS.includes(ext)
            || VIDEO_EXTS.includes(ext)
            || AUDIO_EXTS.includes(ext)
            || DOC_EXTS.includes(ext);
    };

    // Safely escape HTML special characters to prevent XSS
    const escapeHtml = (unsafe) => {
        if (!unsafe) return '';
        return unsafe
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    };

    // Build safe thumbnail URL with proper encoding
    const buildThumbUrl = (entryUri) => {
        if (!entryUri) return '';
        try {
            // entryUri should already be properly encoded by HFS, but be defensive
            return `${escapeHtml(entryUri)}?get=thumb`;
        } catch (e) {
            console.error("Error building thumbnail URL:", e);
            return '';
        }
    };

    // React component for thumbnail display with proper error handling
    function BetterThumbnailIcon({ entry }) {
        // Use ref to track DOM element for event rebinding
        const domRef = HFS.React.useRef(null);
        const [hasError, setHasError] = HFS.React.useState(false);

        // Check file types that need special handling
        const isVideo = VIDEO_EXTS.includes(entry.ext.toLowerCase());
        const isAudio = AUDIO_EXTS.includes(entry.ext.toLowerCase());
        const isDoc = DOC_EXTS.includes(entry.ext.toLowerCase());
		
        // Effect: Handle event rebinding for video/audio/document files
        // For video/audio/document files, Instant-Show binds to the DEFAULT 'span.icon' immediately.
        // When we mount and replace it with OUR 'span.icon', the listener is lost (zombie binding).
        // We must force Instant-Show to find and rebind to our new element.
        // For IMAGES, Instant-Show waits for 'img.thumbnail' tag, so rebinding is not needed.
		
        HFS.React.useEffect(() => {
            if ((isVideo || isAudio || isDoc) && domRef.current) {
                const li = domRef.current.closest('li.file');
                if (li && li.dataset.bound) {
                    // Reset the bind flag so Instant-Show finds the NEW icon
                    delete li.dataset.bound;

                    // Trigger MutationObserver by adding/removing a dummy element
                    const dummy = document.createElement('i');
                    dummy.style.display = 'none';
                    li.appendChild(dummy);
                    setTimeout(() => {
                        try {
                            dummy.remove();
                        } catch (e) {
                            // Already removed
                        }
                    }, 0);
                }
            }
        }, [isVideo, isAudio, isDoc]);

        // Build thumbnail URL safely
        const thumbUrl = buildThumbUrl(entry.uri);

        return h('span', { className: 'icon', ref: domRef },
            h(ImgFallback, {
                fallback: () => entry.getDefaultIcon(),
                tag: 'img',
                props: {
                    src: thumbUrl,
                    className: 'thumbnail', // 'thumbnail' class needed for Instant-Show to find it
                    loading: 'lazy',
                    alt: escapeHtml(entry.name),
                    style: { 
                        maxWidth: '100%', 
                        maxHeight: '100%', 
                        objectFit: 'contain', 
                        borderRadius: '4px' 
                    },
                    onMouseLeave() {
                        try {
                            const preview = document.getElementById('thumbnailsPreview');
                            if (preview) {
                                preview.innerHTML = '';
                            }
                        } catch (e) {
                            console.error("Error clearing preview:", e);
                        }
                    },
                    onMouseEnter(ev) {
                        try {
                            if (!ev.target.closest('.dir')) return;
                            
                            // Only show preview in list mode (not tile mode)
                            if (!HFS.state.tile_size) {
                                const preview = document.getElementById('thumbnailsPreview');
                                if (preview) {
                                    // Create img element with safe URL
                                    const previewUrl = buildThumbUrl(entry.uri);
                                    preview.innerHTML = `<img src="${previewUrl}" class="preview-large" alt="Preview of ${escapeHtml(entry.name)}" />`;
                                }
                            }
                        } catch (e) {
                            console.error("Error showing preview:", e);
                        }
                    },
                }
            })
        );
    }

    // Hook: Replace default entry icons with thumbnails for supported files.
    HFS.onEvent('entryIcon', ({ entry }) => {
        if (!isSupported(entry)) return;
        return h(BetterThumbnailIcon, { entry });
    });

    // Hook: Add preview container and styles to page after list renders
    HFS.onEvent('afterList', () =>
        "<div id='thumbnailsPreview' role='region' aria-label='Thumbnail preview'></div>" +
        "<style>" +
        " #thumbnailsPreview { position: fixed; bottom: 10px; right: 10px; z-index: 100; pointer-events: none; }" +
        " #thumbnailsPreview img.preview-large { max-width: 300px; max-height: 300px; border: 2px solid #fff; box-shadow: 0 0 10px rgba(0,0,0,0.5); background: #000; border-radius: 4px; }" +
        " .icon img.thumbnail { object-fit: contain; border-radius: 4px; }" +
        "</style>"
    );

    // Fallback component: Shows alternative content if image fails to load.
    function ImgFallback({ fallback, tag = 'img', props }) {
        const [err, setErr] = HFS.React.useState(false);
        
        if (err) {
            return fallback ? h(fallback) : null;
        }

        return h(tag, Object.assign({}, props, {
            onError: () => {
                setErr(true);
                if (props.onError) {
                    try {
                        props.onError();
                    } catch (e) {
                        console.error("Error in onError callback:", e);
                    }
                }
            }
        }));
    }

    // Hook: Add "Switch to Tiles Mode" option to file context menu. Only shown for supported files and when not already in tile mode
    HFS.onEvent('fileMenu', ({ entry }) => {
        if (!HFS.state.tile_size && isSupported(entry)) {
            return [{
                icon: '⊞',
                label: t("Enable tiles mode"),
                onClick() {
                    try {
                        HFS.state.tile_size = 10; // Enable tiles (10 = thumbnail size in pixels)
                        HFS.dialogLib.toast(t('Switched to Tiles Mode'));
                    } catch (e) {
                        console.error("Error switching to tiles mode:", e);
                    }
                }
            }];
        }
    });
}
