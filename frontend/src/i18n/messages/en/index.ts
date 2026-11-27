import type { MessagePath, Translatable } from '../../types'
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
 * English is the reference locale: every message lives here first, and its
 * shape defines the keys other locales must provide.
 */
export const en = {
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
} as const

export type Messages = Translatable<typeof en>

export type MessageKey = MessagePath<typeof en>
