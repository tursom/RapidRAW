import { useSettingsStore } from '../store/useSettingsStore';

export const isHistoryMode = (osPlatform = useSettingsStore.getState().osPlatform) => osPlatform !== 'android';
