# Automation package

`@avdm/automation` contains device-independent game automation contracts, OpenCV template vision, and a read-only probe. `@avdm/automation/wanlong` contains the Call of Dragons gather state machine. The host owns emulator lifecycle, per-instance exclusive access, ADB serial resolution, run persistence, and UI.

## Template boundary

The caller passes `templateDir` pointing to one directory with `manifest.json` and its PNG files. The package never searches the repository, auto-imports templates, or writes to that directory. The manifest uses the existing `wanlong-panel` template-set shape (`id`, `name`, optional `packageName`, `refWidth`, `refHeight`, `templates[]`). The loader rejects path traversal, symlinked PNG files, oversized files, duplicate IDs, and invalid metadata.

No user screenshots, account files, template PNGs, or credentials belong in this package. Install or select the template set in a private user-data directory.

## Read-only probe

```ts
import { probeGame } from '@avdm/automation';
import { wanlongPlugin } from '@avdm/automation/wanlong';

const report = await probeGame({
  device, // ReadOnlyDevicePort: capture() and foregroundPackage() only
  templateDir,
  plugin: wanlongPlugin,
});
```

`capture()` returns packed RGBA8888 pixels and the real capture dimensions. `probeGame` captures one frame, prepares it once, and reports match scores in the template set's reference coordinate space. A 960×540 AVD frame is resized to the legacy 2560×1440 reference canvas, so scores must be checked against the actual instance before acting on them.

## Wanlong gather flow

```ts
import {
  createGatherIo, loadGatherTemplates, runGatherCycle,
} from '@avdm/automation/wanlong';

const templates = await loadGatherTemplates({ templateDir });
const io = createGatherIo(device, {
  refWidth: templates.refWidth,
  refHeight: templates.refHeight,
  signal,
});
const result = await runGatherCycle({ io, templates, config, state, signal });
// The desktop runner persists result.state; the generic scheduler persists a next wake when enabled.
```

`DevicePort` receives actual device-pixel coordinates. `createGatherIo` maps reference coordinates to them using the latest captured frame. The host must hold an exclusive lease for the instance throughout the cycle. For Wanlong cold launch, the host adapter must use `monkey -p <package> 1`; the old panel observed that `am start` could return success while the game stayed closed.

The state machine is integrated behind an explicit enable switch and a strict known-scene probe. A no-dispatch cycle has been validated on a real AVD, including city-to-world navigation. Actual dispatch still needs a dedicated live test account and should be treated as preview behavior.

## Packaging

The package uses `sharp` and `@techstark/opencv-js`. Electron packaging must unpack sharp native libraries and the OpenCV WASM runtime from ASAR. The vision module loads OpenCV on first match, keeping application launch light.

## Wanlong cold start, game updates and resource statistics

- `ensureGameForeground(io, { packageName })` (`wanlong/launch.ts`) brings the game to the foreground. The host's launch adapter must be monkey (`AdbDevice.startApp(pkg)` with no activity). `DevicePort.isAppRunning` (optional, `pidof`) only changes the diagnostic wording; `createGatherIo(device, { log })` wires both and stops the wait as soon as the run is aborted. A launched game is not yet usable: callers poll templates afterwards.
- `GameUpdateRecovery` (`wanlong/update.ts`) handles only the calibrated resource-download dialog: two templates in a fixed relative geometry, one click after a fresh re-detection, a cancellable 15-minute wait that never clicks again, and `GAME_UPDATE_REQUIRED` when a person must act. `recoverUnknownWithUpdate` / `createUpdateAwareAdvisor` route unknown screens through it before any BACK press; an optional AI consult port plugs in later. Templates come from the user's template set (`importGameUpdateTemplates` re-anchors the old panel's crops).
- `readResourceStatsPanel({ io, templates, templateDir, instanceIndex, log })` (`wanlong/resources/`) reads 道具 → 资源 → 资源统计 over the same `GatherIo` as the gather flow: required-template gate, main-screen precheck that sends no input on failure, BACK×2 restore with the quit-dialog guard. The renderer-safe contract (`ResourceSnapshot`, `parseCnAmount`, `formatCnAmount`, `renderResourceSnapshotText`, layout, template ids) lives in `wanlong/resources/pure.ts`.
- `game-data/wanlong/*.json` are the sanitized specifications (coordinates, state machine, template catalog, config schema) ported from the old panel; they are documentation, and hand copies in code are pinned by tests. Game docs are in `docs/wanlong/`.
