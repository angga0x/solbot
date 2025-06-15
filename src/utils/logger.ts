// Basic logger utility
// Can be expanded with levels, file logging, etc.

enum LogLevel {
  INFO = "INFO",
  WARN = "WARN",
  ERROR = "ERROR",
  DEBUG = "DEBUG",
}

function getTimestamp(): string {
  return new Date().toISOString();
}

export function info(message: string, ...args: any[]): void {
  console.log(`[${getTimestamp()}] [${LogLevel.INFO}] ${message}`, ...args);
}

export function warn(message: string, ...args: any[]): void {
  console.warn(`[${getTimestamp()}] [${LogLevel.WARN}] ${message}`, ...args);
}

export function error(message: string, ...args: any[]): void {
  console.error(`[${getTimestamp()}] [${LogLevel.ERROR}] ${message}`, ...args);
}

export function debug(message: string, ...args: any[]): void {
  // Debug logs can be conditional, e.g., based on an environment variable
  if (process.env.NODE_ENV === 'development' || process.env.DEBUG === 'true') {
    console.debug(`[${getTimestamp()}] [${LogLevel.DEBUG}] ${message}`, ...args);
  }
}

export const logger = {
  info,
  warn,
  error,
  debug,
};
