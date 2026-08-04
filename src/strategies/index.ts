import type { ResolvedConfig, Strategy, StrategyName } from '../types.js'
import { createDatabaseStrategy } from './database.js'
import { createTransactionStrategy } from './transaction.js'

export { createDatabaseStrategy } from './database.js'
export { createTransactionStrategy } from './transaction.js'

/** Build the strategy the run asked for. */
export function makeStrategy(name: StrategyName, config: ResolvedConfig): Strategy {
  switch (name) {
    case 'transaction':
      return createTransactionStrategy(config)
    case 'database':
      return createDatabaseStrategy(config)
    default: {
      const unknown: never = name
      throw new Error(
        `dbtx: unknown strategy ${JSON.stringify(unknown)}. Use 'transaction' or 'database'.`,
      )
    }
  }
}
