import os from 'node:os';
import path from 'node:path';
import type { ManagerPaths } from './types.js';

export function defaultHome(): string {
  return process.env.AVDM_HOME || path.join(os.homedir(), '.avdm');
}

export function resolvePaths(home: string = defaultHome()): ManagerPaths {
  const logsDir = path.join(home, 'logs');
  return {
    home,
    settingsFile: path.join(home, 'settings.json'),
    registryFile: path.join(home, 'instances.json'),
    avdHome: path.join(home, 'avd'),
    logsDir,
    scriptLogsDir: path.join(logsDir, 'scripts'),
    runDir: path.join(home, 'run'),
    scriptsDir: path.join(home, 'scripts'),
    downloadsDir: path.join(home, 'cache', 'downloads'),
  };
}

/** Standard SDK location used by Android Studio on each OS, overridable by ANDROID_HOME / ANDROID_SDK_ROOT. */
export function defaultSdkRoot(): string {
  const env = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (env) return env;
  const home = os.homedir();
  switch (process.platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Android', 'sdk');
    case 'win32':
      return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Android', 'Sdk');
    default:
      return path.join(home, 'Android', 'Sdk');
  }
}

/**
 * Directory where the emulator writes discovery files `pid_<pid>.ini` for each running instance.
 * macOS: ~/Library/Caches/TemporaryItems/avd/running
 * Linux: $XDG_RUNTIME_DIR/avd/running (fallback /tmp/android-$USER/avd/running)
 * Windows: %LOCALAPPDATA%\Temp\avd\running
 */
export function emulatorDiscoveryDirs(): string[] {
  // Test hook: fake emulators in tests write discovery files here.
  if (process.env.AVDM_DISCOVERY_DIR) return [process.env.AVDM_DISCOVERY_DIR];
  const home = os.homedir();
  switch (process.platform) {
    case 'darwin':
      return [path.join(home, 'Library', 'Caches', 'TemporaryItems', 'avd', 'running')];
    case 'win32':
      return [path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Temp', 'avd', 'running')];
    default: {
      const dirs: string[] = [];
      if (process.env.XDG_RUNTIME_DIR) dirs.push(path.join(process.env.XDG_RUNTIME_DIR, 'avd', 'running'));
      dirs.push(path.join(os.tmpdir(), `android-${os.userInfo().username}`, 'avd', 'running'));
      return dirs;
    }
  }
}

/** Emulator console auth token file (used by the telnet console `auth` command). */
export function consoleAuthTokenFile(): string {
  return path.join(os.homedir(), '.emulator_console_auth_token');
}
