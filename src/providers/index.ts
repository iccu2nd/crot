import type { ProviderAdapter, ProviderKey } from '../core/types.js'
import { createLumos } from './lumos.js'
import { createKiryuu } from './kiryuu.js'
import { createShinigami } from './shinigami.js'

const factories: Record<ProviderKey, () => ProviderAdapter> = {
  lumos: createLumos,
  shinigami: createShinigami,
  kiryuu: createKiryuu
}

/** Urutan `keys` = prioritas provider. */
export const createProviders = (keys: ProviderKey[]): ProviderAdapter[] => keys.map(k => factories[k]())
