import pino, { type Logger, type LoggerOptions } from 'pino'

import type { AlfredConfiguration } from './configuration.js'

const loggerOptions: LoggerOptions = {
  name: 'alfred',
  level: 'info'
}

const rootLogger: Logger = pino(loggerOptions)

export function configureLogger(configuration: Pick<AlfredConfiguration, 'logging'>): Logger {
  rootLogger.level = configuration.logging.level
  return rootLogger
}

export function getLogger(component?: string): Logger {
  return component === undefined ? rootLogger : rootLogger.child({ component })
}
