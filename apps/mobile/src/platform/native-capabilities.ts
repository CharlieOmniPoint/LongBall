import { requireOptionalNativeModule } from 'expo';
import type { NativeCapabilities } from './types';

/** Expo Go and older clients deliberately cannot activate the encrypted experiment. */
export const nativeCapabilities = requireOptionalNativeModule<NativeCapabilities>('LongBallNative');
