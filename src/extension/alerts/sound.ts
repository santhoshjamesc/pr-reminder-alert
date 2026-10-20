import { execFile } from 'node:child_process';
import * as fs from 'node:fs';

let lastPlayed = 0;

/**
 * Plays a short system sound with the platform's standard player. Uses
 * execFile (no shell) and is throttled so alerts can never become a stream
 * of noise. Failures are ignored: sound is best-effort.
 */
export function playAlertSound(customFile: string, onError: (message: string) => void): void {
  const now = Date.now();
  if (now - lastPlayed < 5000) {
    return;
  }
  lastPlayed = now;
  const file = customFile && fs.existsSync(customFile) ? customFile : '';
  const done = (error: Error | null) => {
    if (error) {
      onError(`Could not play alert sound: ${error.message}`);
    }
  };
  switch (process.platform) {
    case 'darwin':
      execFile('afplay', [file || '/System/Library/Sounds/Glass.aiff'], { timeout: 10_000 }, done);
      break;
    case 'win32': {
      const script = file
        ? `(New-Object Media.SoundPlayer $env:PR_REMINDER_SOUND).PlaySync()`
        : '[System.Media.SystemSounds]::Exclamation.Play(); Start-Sleep -Milliseconds 800';
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 10_000, env: { ...process.env, PR_REMINDER_SOUND: file } }, done);
      break;
    }
    default: {
      const target = file || '/usr/share/sounds/freedesktop/stereo/complete.oga';
      execFile('paplay', [target], { timeout: 10_000 }, (error) => {
        if (error) {
          execFile('aplay', ['-q', target], { timeout: 10_000 }, done);
        }
      });
    }
  }
}
