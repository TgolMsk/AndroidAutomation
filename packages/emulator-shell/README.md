# Emulator Shell

`@avdm/emulator-shell` holds the Electron plumbing shared by the emulator manager and game assistants. It does not own a product entry point or installer.

| Export | Purpose |
| --- | --- |
| `main/bootstrap` | Start an Electron product with generic emulator services and optional product services. |
| `main/ipc-handlers`, `shared/ipc` | Authorized, typed emulator commands and events. |
| `renderer/views/LiveView` | Reusable live emulator window. |
| `renderer/components/*`, `renderer/hooks/*`, `renderer/format` | Shared UI primitives (Icon, StatusBadge, Toasts, Modal, ConfirmDialog, DropdownMenu, Drawer) and instance state. |
| `renderer/styles.css` | Shared dark design tokens and emulator UI styles. |

Each product owns its own `src/main/index.ts`, preload, renderer entry, app ID, icon, and `electron-builder.yml`. The manager calls `bootstrapApp({ name })`; an assistant adds its services via `createAddon` and registers its own namespaced IPC. Both depend on `@avdm/core` for instance state and CLI-equivalent operations. No shell module imports from a product directory.

The package exports TypeScript source so `electron-vite` bundles it into each product. Keep `@avdm/emulator-shell` in the product's `externalizeDeps.exclude` list. The main bundle must retain the usual `out/main`, `out/preload`, and `out/renderer` sibling layout because `WindowManager` resolves preload and HTML beside the bundled main file. Game rules, accounts, schedules, templates, and credentials belong in an assistant, never in this package.
