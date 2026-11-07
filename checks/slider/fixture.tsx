import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { useSettingsStore } from '../../src/store/useSettingsStore';
import { useEditorStore } from '../../src/store/useEditorStore';
import type { SliderChangeEvent, SliderScale } from '../../src/components/ui/Slider';
import './actualstyles.css';

const before = new URLSearchParams(location.search).has('old');
const { default: Slider } = before
  ? await import('virtual:slider-before')
  : await import('../../src/components/ui/Slider');

const i18n = i18next.createInstance();
await i18n.init({
  lng: 'en',
  resources: {
    en: { translation: { ui: { slider: { reset: 'Reset', clickToEdit: 'Click to edit' } } } },
  },
  interpolation: { escapeValue: false },
});

interface Configuration {
  width: number;
  min: number;
  max: number;
  step: number;
  value: number;
  platform: string;
  defaultValue?: number;
  snapToZero?: boolean;
  nonlinear?: boolean;
}

interface Observation {
  kind: string;
  phase: string;
  [key: string]: unknown;
}

const nonlinearScale: SliderScale = {
  toPosition: (value) => Math.sqrt(value + 100),
  fromPosition: (position) => position ** 2 - 100,
};
let phase = 'initial';
let observations: Observation[] = [];
const record = (kind: string, details: Record<string, unknown>) => {
  observations.push({ kind, phase, ...details });
};

for (const type of [
  'pointerdown',
  'pointermove',
  'pointerup',
  'mousedown',
  'mousemove',
  'mouseup',
  'click',
  'dblclick',
  'touchstart',
  'touchmove',
  'touchend',
  'touchcancel',
  'input',
  'change',
  'keydown',
  'keyup',
  'wheel',
]) {
  document.addEventListener(
    type,
    (event) => {
      const target = event.target;
      const input = target instanceof HTMLInputElement ? target : null;
      const touch = event instanceof TouchEvent ? event.touches[0] : null;
      const pointer = event instanceof MouseEvent ? event : null;
      const modifier = event as MouseEvent | KeyboardEvent | TouchEvent;
      record('native', {
        type,
        trusted: event.isTrusted,
        target: input?.type ?? (target instanceof Element ? target.tagName : null),
        rawValue: input?.value ?? null,
        x: touch?.clientX ?? pointer?.clientX ?? null,
        y: touch?.clientY ?? pointer?.clientY ?? null,
        key: event instanceof KeyboardEvent ? event.key : null,
        shift: modifier.shiftKey ?? false,
        alt: modifier.altKey ?? false,
      });
    },
    true,
  );
}

// Observe the same bubbling boundary used by editor shortcuts without mounting editor/backend flows.
window.addEventListener('keydown', (event) => {
  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  record('globalShortcut', {
    key: event.key,
    trusted: event.isTrusted,
    ctrl: event.ctrlKey,
    meta: event.metaKey,
    target: event.target instanceof HTMLInputElement ? event.target.type : 'outside-input',
  });
});

let configure: (configuration: Configuration) => void;

function Fixture() {
  const [configuration, setConfiguration] = useState<Configuration>({
    width: 200,
    min: -100,
    max: 100,
    step: 0.1,
    value: 0,
    platform: 'windows',
  });
  const [epoch, setEpoch] = useState(0);
  const [value, setValue] = useState(0);
  configure = (next) => {
    useSettingsStore.setState({ osPlatform: next.platform });
    useEditorStore.setState({ speedEditTarget: null, isSliderDragging: false });
    flushSync(() => {
      setConfiguration(next);
      setValue(next.value);
      setEpoch((previous) => previous + 1);
    });
  };
  const onChange = (event: SliderChangeEvent) => {
    const next = Number(event.target.value);
    // Record synchronously before React can batch or replace an intermediate output.
    record('output', { value: next });
    setValue(next);
  };
  return (
    <I18nextProvider i18n={i18n}>
      <main id="fixture" style={{ width: configuration.width }}>
        <Slider
          key={epoch}
          label="Regression slider"
          min={configuration.min}
          max={configuration.max}
          step={configuration.step}
          defaultValue={configuration.defaultValue}
          snapToZero={configuration.snapToZero}
          scale={configuration.nonlinear ? nonlinearScale : undefined}
          value={value}
          animateValueChanges={false}
          onChange={onChange}
          onDragStateChange={(dragging) => {
            record('drag', { dragging });
            useEditorStore.setState({ isSliderDragging: dragging });
          }}
          onPointerUp={() => record('pointerUp', {})}
        />
        <output id="value">{value}</output>
      </main>
    </I18nextProvider>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);

const api = {
  before,
  configure(configuration: Configuration) {
    phase = 'setup';
    configure(configuration);
  },
  clear() {
    observations = [];
    phase = 'setup';
  },
  mark(next: string) {
    phase = next;
    record('mark', {});
  },
  read: () => observations,
  speedEdit(position: number) {
    const target = useEditorStore.getState().speedEditTarget?.current;
    if (!target) throw new Error('No real editor-store SpeedEdit target has been claimed');
    record('api', { method: 'SpeedEditTarget.toValue/onChange', position });
    target.onDragStateChange(true);
    target.onChange(target.toValue(position));
    target.onDragStateChange(false);
  },
};

declare global {
  interface Window {
    sliderFixture: typeof api;
  }
}
window.sliderFixture = api;
