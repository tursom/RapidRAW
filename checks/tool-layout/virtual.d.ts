declare module 'virtual:task3-ui' {
  export const reconcileWorkspace: typeof import('../../src/store/useUIStore').reconcileWorkspace;
  export const useUIStore: typeof import('../../src/store/useUIStore').useUIStore;
  export const isPanelVisible: typeof import('../../src/store/useUIStore').isPanelVisible;
}
declare module 'virtual:mask-visibility' {
  type UIState = ReturnType<typeof import('../../src/store/useUIStore').useUIStore.getState>;
  export function current(state: UIState): boolean;
  export function task3(state: UIState): boolean;
}
declare module 'virtual:canvas-selectors' {
  type UIState = ReturnType<typeof import('../../src/store/useUIStore').useUIStore.getState>;
  export function current(state: UIState): { center: boolean; relight: boolean };
  export function task3(state: UIState): { center: boolean; relight: boolean };
}
declare module 'virtual:task3-speed-edit' {
  const Overlay: typeof import('../../src/components/panel/editor/overlays/SpeedEditOverlay').default;
  export default Overlay;
}
