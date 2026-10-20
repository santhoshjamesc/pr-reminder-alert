import * as fs from 'node:fs';
import * as path from 'node:path';
import { ZodError } from 'zod';
import { type AppConfig, parseConfig } from './schema';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function formatZodError(error: ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

/**
 * Holds the current non-secret configuration and persists updates to a JSON
 * file so the service restarts with the last known configuration.
 */
export class ConfigStore {
  private current: AppConfig | null = null;
  private readonly listeners = new Set<(config: AppConfig) => void>();

  constructor(private readonly filePath: string | null) {}

  load(): AppConfig | null {
    if (!this.filePath || !fs.existsSync(this.filePath)) {
      return this.current;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch (error) {
      throw new ConfigError(`Config file ${path.basename(this.filePath)} is not valid JSON: ${(error as Error).message}`);
    }
    this.current = this.validate(raw);
    return this.current;
  }

  get(): AppConfig | null {
    return this.current;
  }

  validate(raw: unknown): AppConfig {
    try {
      return parseConfig(raw);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new ConfigError(`Invalid configuration: ${formatZodError(error)}`);
      }
      throw error;
    }
  }

  /** Validates, persists (atomically, mode 0600) and broadcasts a new configuration. */
  update(raw: unknown): AppConfig {
    const config = this.validate(raw);
    if (this.filePath) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
    }
    this.current = config;
    for (const listener of this.listeners) {
      listener(config);
    }
    return config;
  }

  onChange(listener: (config: AppConfig) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
