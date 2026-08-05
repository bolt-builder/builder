import { reactRouter } from '@react-router/dev/vite';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import { visualizer } from 'rollup-plugin-visualizer';
import UnoCSS from 'unocss/vite';
import type { PluginOption } from 'vite';
import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { optimizeCssModules } from 'vite-plugin-optimize-css-modules';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig((config) => {
  return {
    server: {
      port: Number(process.env.PORT) || 5173,
      strictPort: true,
      fs: {
        /*
         * Allow serving files when ?url= query param is used. Vite reserves ?url for
         * its module system, which conflicts with our template import ?url=https://... pattern.
         */
        strict: false,
      },
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV),
    },
    build: {
      target: 'esnext',

      /*
       * Production sourcemaps are opt-in (SOURCEMAP=true pnpm run build).
       * They expose server code in the browser (Vite warns loudly about this)
       * and generating them for large chunks like monaco-editor can exhaust
       * memory on 8 GB machines.
       */
      sourcemap: process.env.SOURCEMAP === 'true',
      rollupOptions: {
        // Externalize undici and util/types for client builds - these are server-only modules
        external: ['undici', 'util/types', 'node:util/types'],
      },
    },
    resolve: {
      dedupe: [
        'react',
        'react-dom',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
        'react-dom/client',
        'react-router',
        '@nanostores/react',
      ],
      alias: {
        // Provide empty shim for util/types in client builds
        'util/types': 'rollup-plugin-node-polyfills/polyfills/empty',
        'node:util/types': 'rollup-plugin-node-polyfills/polyfills/empty',
      },
    },
    ssr: {
      // Use native Node.js modules for SSR - don't polyfill these
      noExternal: [],
      external: [
        'stream',
        'node:stream',
        'util',
        'util/types',
        'node:util',
        'node:util/types',
        'buffer',
        'node:buffer',
        'react-window',
      ],
    },
    plugins: [
      nodePolyfills({
        include: ['buffer', 'process', 'util'],
        globals: {
          Buffer: true,
          process: true,
          global: true,
        },
        protocolImports: true,
        exclude: ['child_process', 'fs', 'path', 'stream'],
      }),
      {
        name: 'buffer-polyfill',
        transform(code: string, id: string) {
          if (id.includes('env.mjs')) {
            return {
              code: `import { Buffer } from 'buffer';\n${code}`,
              map: null,
            };
          }

          return null;
        },
      },
      reactRouter(),
      UnoCSS(),
      tsconfigPaths(),
      config.mode === 'production' && optimizeCssModules({ apply: 'build' }),
      process.env.ANALYZE
        ? visualizer({
            filename: 'stats.html',
            open: true,
            gzipSize: true,
            brotliSize: true,
          })
        : false,
      config.mode === 'production' &&
        process.env.SENTRY_AUTH_TOKEN &&
        sentryVitePlugin({
          org: process.env.SENTRY_ORG,
          project: process.env.SENTRY_PROJECT,
          authToken: process.env.SENTRY_AUTH_TOKEN,
          sourcemaps: {
            filesToDeleteAfterUpload: ['./build/**/*.map'],
          },
          telemetry: false,
        }),
    ].filter(Boolean) as PluginOption[],
    envPrefix: [
      'VITE_',
      'OPENAI_LIKE_API_BASE_URL',
      'OPENAI_LIKE_API_MODELS',
      'OLLAMA_API_BASE_URL',
      'LMSTUDIO_API_BASE_URL',
      'TOGETHER_API_BASE_URL',
      'SENTRY_DSN',
    ],
    css: {
      preprocessorOptions: {
        scss: {
          api: 'modern-compiler',
        },
      },
    },
    optimizeDeps: {
      include: [
        // React core — must be pre-bundled so every dep shares one React instance
        'react',
        'react-dom',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
        'react-dom/client',

        // React ecosystem — CJS or complex dependency graphs
        '@ai-sdk/react',
        '@nanostores/react',
        'nanostores',
        'framer-motion',
        'react-window',

        // CJS / UMD packages — need Vite conversion to ESM
        'diff',
        'dompurify',
        'file-saver',
        'ignore',
        'isomorphic-git',
        'jszip',
        'path-browserify',
        'react-qrcode-logo',

        // Complex ESM — deep dep graphs or dynamic/lazy loading
        'shiki',

        // Radix UI — CJS with many shared internal sub-packages
        '@radix-ui/react-checkbox',
        '@radix-ui/react-collapsible',
        '@radix-ui/react-context-menu',
        '@radix-ui/react-dialog',
        '@radix-ui/react-dropdown-menu',
        '@radix-ui/react-label',
        '@radix-ui/react-popover',
        '@radix-ui/react-scroll-area',
        '@radix-ui/react-switch',
        '@radix-ui/react-tabs',
        '@radix-ui/react-tooltip',
        '@radix-ui/react-visually-hidden',

        // CodeMirror — tightly coupled modules, must be pre-bundled together
        '@codemirror/autocomplete',
        '@codemirror/commands',
        '@codemirror/lang-cpp',
        '@codemirror/lang-css',
        '@codemirror/lang-html',
        '@codemirror/lang-javascript',
        '@codemirror/lang-json',
        '@codemirror/lang-markdown',
        '@codemirror/lang-python',
        '@codemirror/lang-sass',
        '@codemirror/lang-vue',
        '@codemirror/lang-wast',
        '@codemirror/language',
        '@codemirror/search',
        '@codemirror/state',
        '@codemirror/view',
        '@uiw/codemirror-theme-vscode',

        // Terminal emulator
        '@xterm/addon-fit',
        '@xterm/addon-web-links',
        '@xterm/xterm',
      ],
      /*
       * monaco-editor must NOT be pre-bundled: its `?worker` imports resolve
       * against the real package files, and the dep optimizer breaks that
       * (".vite/deps/ts.worker.js?worker_file" does not exist).
       */
      exclude: ['undici', 'monaco-editor'],
    },
  };
});
