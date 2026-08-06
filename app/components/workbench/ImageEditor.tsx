/**
 * Image editing panel for the Element Inspector.
 *
 * Shown when the selected element is an `<img>` or has a CSS
 * `background-image`. Supports:
 * - Image preview thumbnail
 * - URL editing for `src` / `background-image`
 * - File upload (converted to a data-URL for live preview)
 * - Alt text editing
 * - Natural dimensions display
 *
 * @module workbench/ImageEditor
 */

import { memo, useState, useCallback, useRef } from 'react';

/* ─── Props ────────────────────────────────────────────────────────── */

interface ImageEditorProps {
  /** Current image source URL. */
  src: string;

  /** Alt text of the image (empty if not an `<img>`). */
  alt?: string;

  /** Natural width of the image, if available. */
  naturalWidth?: number;

  /** Natural height of the image, if available. */
  naturalHeight?: number;

  /** CSS `background-image` value (e.g. `url(...)`), if applicable. */
  backgroundImage?: string;

  /** Called when the `src` attribute should change. */
  onSrcChange: (src: string) => void;

  /** Called when the `alt` attribute should change. */
  onAltChange: (alt: string) => void;

  /** Called when a CSS `background-image` property should change. */
  onBackgroundImageChange: (value: string) => void;
}

/* ─── Helpers ──────────────────────────────────────────────────────── */

/** Extract the raw URL from a CSS `url(...)` value. */
function extractUrlFromCss(value: string): string {
  const match = value.match(/url\(["']?([^"')]+)["']?\)/);
  return match ? match[1] : value;
}

/** Format bytes to a human-readable string. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ─── Component ────────────────────────────────────────────────────── */

export const ImageEditor = memo(
  ({
    src,
    alt,
    naturalWidth,
    naturalHeight,
    backgroundImage,
    onSrcChange,
    onAltChange,
    onBackgroundImageChange,
  }: ImageEditorProps) => {
    const [localSrc, setLocalSrc] = useState(src);
    const [localAlt, setLocalAlt] = useState(alt ?? '');
    const [localBgUrl, setLocalBgUrl] = useState(backgroundImage ? extractUrlFromCss(backgroundImage) : '');
    const [uploadInfo, setUploadInfo] = useState<string | null>(null);
    const [previewError, setPreviewError] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    /* ── Image source ────────────────────────────────────────────── */

    const handleSrcCommit = useCallback(() => {
      if (localSrc.trim() && localSrc !== src) {
        onSrcChange(localSrc.trim());
      }
    }, [localSrc, src, onSrcChange]);

    const handleSrcKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
          handleSrcCommit();
        }
      },
      [handleSrcCommit],
    );

    /* ── Alt text ────────────────────────────────────────────────── */

    const handleAltCommit = useCallback(() => {
      if (localAlt !== (alt ?? '')) {
        onAltChange(localAlt);
      }
    }, [localAlt, alt, onAltChange]);

    const handleAltKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
          handleAltCommit();
        }
      },
      [handleAltCommit],
    );

    /* ── Background image ────────────────────────────────────────── */

    const handleBgCommit = useCallback(() => {
      const trimmed = localBgUrl.trim();

      if (trimmed) {
        onBackgroundImageChange(`url("${trimmed}")`);
      }
    }, [localBgUrl, onBackgroundImageChange]);

    const handleBgKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
          handleBgCommit();
        }
      },
      [handleBgCommit],
    );

    /* ── File upload ─────────────────────────────────────────────── */

    const handleFileSelect = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];

        if (!file) {
          return;
        }

        // Validate file type
        if (!file.type.startsWith('image/')) {
          setUploadInfo('Not a valid image file');
          setTimeout(() => setUploadInfo(null), 3000);

          return;
        }

        // Limit to 5 MB for data-URL usage
        const MAX_SIZE = 5 * 1024 * 1024;

        if (file.size > MAX_SIZE) {
          setUploadInfo(`File too large (${formatBytes(file.size)}). Max 5 MB.`);
          setTimeout(() => setUploadInfo(null), 3000);

          return;
        }

        const reader = new FileReader();

        reader.onload = () => {
          const dataUrl = reader.result as string;
          setLocalSrc(dataUrl);
          onSrcChange(dataUrl);
          setUploadInfo(`${file.name} (${formatBytes(file.size)})`);
          setPreviewError(false);
        };

        reader.onerror = () => {
          setUploadInfo('Failed to read file');
          setTimeout(() => setUploadInfo(null), 3000);
        };

        reader.readAsDataURL(file);
      },
      [onSrcChange],
    );

    const triggerFileInput = useCallback(() => {
      fileInputRef.current?.click();
    }, []);

    /* ── Determine preview image ─────────────────────────────────── */

    const previewSrc = localSrc || (backgroundImage ? extractUrlFromCss(backgroundImage) : '');
    const isDataUrl = previewSrc.startsWith('data:');

    return (
      <div className="space-y-3">
        {/* Preview thumbnail */}
        {previewSrc && !previewError && (
          <div className="relative rounded border border-bolt-elements-borderColor overflow-hidden bg-[#0d0d0d]">
            <img
              src={previewSrc}
              alt={localAlt || 'Image preview'}
              onError={() => setPreviewError(true)}
              className="w-full h-auto max-h-40 object-contain"
              style={{ imageRendering: 'auto' }}
            />
            {/* Dimensions overlay */}
            {naturalWidth != null && naturalHeight != null && (
              <span className="absolute bottom-1 right-1 text-[10px] bg-black/70 text-white/80 px-1.5 py-0.5 rounded font-mono">
                {naturalWidth} &times; {naturalHeight}
              </span>
            )}
          </div>
        )}

        {/* Preview error fallback */}
        {previewError && (
          <div className="flex items-center gap-2 p-2 rounded border border-red-500/30 bg-red-500/5 text-xs text-red-400">
            <div className="i-ph:warning w-4 h-4 shrink-0" aria-hidden="true" />
            Failed to load image preview
          </div>
        )}

        {/* Image source URL */}
        {src && (
          <fieldset className="space-y-1">
            <label
              htmlFor="image-src-input"
              className="text-[10px] font-medium text-bolt-elements-textSecondary uppercase tracking-wider"
            >
              Source URL
            </label>
            <div className="flex gap-1">
              <input
                id="image-src-input"
                type="text"
                value={isDataUrl ? '(uploaded file)' : localSrc}
                onChange={(e) => {
                  setLocalSrc(e.target.value);
                  setPreviewError(false);
                }}
                onBlur={handleSrcCommit}
                onKeyDown={handleSrcKeyDown}
                disabled={isDataUrl}
                className="flex-1 bg-bolt-elements-background-depth-3 border border-bolt-elements-borderColor rounded px-2 py-1.5 text-bolt-elements-textPrimary text-xs font-mono focus:outline-none focus:border-accent-400 disabled:opacity-50 disabled:cursor-not-allowed min-w-0"
                placeholder="https://example.com/image.png"
              />
            </div>
            {uploadInfo && (
              <p className="text-[10px] text-bolt-elements-textSecondary truncate" title={uploadInfo}>
                {uploadInfo}
              </p>
            )}
          </fieldset>
        )}

        {/* File upload */}
        <div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleFileSelect}
            className="sr-only"
            aria-label="Upload image file"
          />
          <button
            onClick={triggerFileInput}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded border border-dashed border-bolt-elements-borderColor bg-bolt-elements-background-depth-3 text-bolt-elements-textSecondary hover:border-accent-400 hover:text-accent-400 transition-colors"
          >
            <div className="i-ph:upload-simple w-3.5 h-3.5" aria-hidden="true" />
            Upload Image
          </button>
        </div>

        {/* Alt text */}
        {src && (
          <fieldset className="space-y-1">
            <label
              htmlFor="image-alt-input"
              className="text-[10px] font-medium text-bolt-elements-textSecondary uppercase tracking-wider flex items-center gap-1"
            >
              Alt Text
              {!localAlt && (
                <span
                  className="text-amber-400 normal-case tracking-normal"
                  title="Images should have alt text for accessibility"
                >
                  (missing)
                </span>
              )}
            </label>
            <input
              id="image-alt-input"
              type="text"
              value={localAlt}
              onChange={(e) => setLocalAlt(e.target.value)}
              onBlur={handleAltCommit}
              onKeyDown={handleAltKeyDown}
              className="w-full bg-bolt-elements-background-depth-3 border border-bolt-elements-borderColor rounded px-2 py-1.5 text-bolt-elements-textPrimary text-xs focus:outline-none focus:border-accent-400 min-w-0"
              placeholder="Describe the image for accessibility"
            />
          </fieldset>
        )}

        {/* Background image URL */}
        {backgroundImage && (
          <fieldset className="space-y-1">
            <label
              htmlFor="image-bg-input"
              className="text-[10px] font-medium text-bolt-elements-textSecondary uppercase tracking-wider"
            >
              Background Image
            </label>
            <input
              id="image-bg-input"
              type="text"
              value={localBgUrl}
              onChange={(e) => setLocalBgUrl(e.target.value)}
              onBlur={handleBgCommit}
              onKeyDown={handleBgKeyDown}
              className="w-full bg-bolt-elements-background-depth-3 border border-bolt-elements-borderColor rounded px-2 py-1.5 text-bolt-elements-textPrimary text-xs font-mono focus:outline-none focus:border-accent-400 min-w-0"
              placeholder="https://example.com/bg.png"
            />
          </fieldset>
        )}
      </div>
    );
  },
);

ImageEditor.displayName = 'ImageEditor';
