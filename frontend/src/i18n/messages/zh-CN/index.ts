import type { Messages } from '../en'
import app from './app'
import common from './common'
import dates from './dates'
import exportDoc from './exportDoc'
import feedback from './feedback'
import home from './home'
import importing from './importing'
import labs from './labs'
import meeting from './meeting'
import modelCatalog from './modelCatalog'
import modelManagers from './modelManagers'
import models from './models'
import onboarding from './onboarding'
import people from './people'
import recording from './recording'
import settings from './settings'
import shell from './shell'
import summaries from './summaries'
import ui from './ui'

/**
 * Simplified Chinese messages. Typed with the English shape so a missing key is
 * a compile error; `tests/i18n/messages.test.ts` also checks key parity and
 * placeholder agreement at runtime.
 */
export const zhCN: Messages = {
  app,
  common,
  dates,
  exportDoc,
  feedback,
  home,
  importing,
  labs,
  meeting,
  modelCatalog,
  modelManagers,
  models,
  onboarding,
  people,
  recording,
  settings,
  shell,
  summaries,
  ui,
}
