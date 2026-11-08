declare module 'virtual:task4-actions' {
  export const cancelCrop: typeof import('../../src/hooks/useEditorActions').cancelCrop;
  export const debouncedSetHistory: typeof import('../../src/hooks/useEditorActions').debouncedSetHistory;
  export const debouncedSave: typeof import('../../src/hooks/useEditorActions').debouncedSave;
}
declare module 'virtual:task4-keyboard' {
  export const useKeyboardShortcuts: typeof import('../../src/hooks/useKeyboardShortcuts').useKeyboardShortcuts;
}
