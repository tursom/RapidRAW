import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const tools = ['crop', 'masks', 'ai'];
export const required = tools
  .flatMap((tool) =>
    ['isGeneratingAi', 'isGeneratingAiMask', 'container-isLoading', 'activeAiTasks'].map(
      (flag) => `busy-${tool}-${flag}`,
    ),
  )
  .concat(['new-image-not-ready', 'ai-prompt-enter']);
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unchanged = (step) => !!step && isDeepStrictEqual(step.before.adjustments, step.after.adjustments);
const sameMode = (step) => !!step && step.before.activePanel === step.after.activePanel;
const passed = (step) => step?.status === 'passed';
const trustedEnter = (events) =>
  ['keydown', 'keyup'].every((type) =>
    events.some((event) => event.type === type && event.code === 'Enter' && event.trusted === true),
  );

// This is a derived view of retained observations, never a second source of pass flags.
// Every row retains its exact source records, their indices and their serialization digest.
export function buildNativeSupplement(report) {
  const rows = [];
  const references = (sources) =>
    sources.flatMap(({ entry, steps }) =>
      steps.filter(Boolean).map((step) => ({
        caseIndex: report.cases.indexOf(entry),
        caseName: entry.name,
        stepIndex: entry.steps.indexOf(step),
        recordSha256: sha(step),
        record: step,
      })),
    );
  const add = (name, flag, value, sources, assertions, source = 'browser-simulated-editorflag') => {
    const records = references(sources);
    const events = records.flatMap(({ record }) => record.trace.filter((event) => event.kind === 'input'));
    rows.push({
      name,
      passed:
        sources.every(({ entry, steps }) => entry.status === 'passed' && steps.every(passed)) &&
        Object.values(assertions).every((value) => value === true) &&
        trustedEnter(events) &&
        events.length > 0 &&
        events.every((event) => event.trusted === true),
      source,
      setup: { flag, value },
      assertions,
      events,
      records,
    });
  };
  for (const tool of tools) {
    for (const flag of ['isGeneratingAi', 'isGeneratingAiMask', 'container-isLoading', 'activeAiTasks']) {
      const kinds = flag === 'container-isLoading' ? ['maskLoading', 'aiLoading'] : [flag];
      const entries = kinds.map((kind) =>
        report.cases.find((entry) => entry.name === `${tool}: busy ${kind} guards buttons, Enter and outer Escape`),
      );
      if (entries.some((entry) => !entry)) continue;
      const sources = entries.map((entry, index) => ({
        entry,
        steps: [
          entry.steps.find((step) => step.name === 'native disabled buttons'),
          entry.steps.find((step) => step.name === 'busy Enter inert'),
          entry.steps.find((step) => step.name === 'busy Escape inert'),
          entry.steps.find((step) => step.name === `mock busy state ${kinds[index]}`),
        ],
      }));
      add(`busy-${tool}-${flag}`, flag, true, sources, {
        applyDisabled: sources.every(({ steps }) => steps[0]?.dom?.applyDisabled === true),
        cancelDisabled: sources.every(({ steps }) => steps[0]?.dom?.cancelDisabled === true),
        enterBlocked: sources.every(({ steps }) => passed(steps[1]) && sameMode(steps[1]) && unchanged(steps[1])),
        toolDataUnchanged: sources.every(({ steps }) => unchanged(steps[1]) && unchanged(steps[2])),
        modeUnchanged: sources.every(({ steps }) => sameMode(steps[1]) && sameMode(steps[2])),
        flagObserved: sources.every(({ steps }, index) => {
          const state = steps[0]?.before;
          if (!state) return false;
          if (flag === 'container-isLoading')
            return state.adjustments[kinds[index] === 'maskLoading' ? 'masks' : 'aiPatches'].some(
              (container) => container.isLoading === true,
            );
          return flag === 'activeAiTasks' ? Object.keys(state.activeAiTasks).length > 0 : state[flag] === true;
        }),
      });
    }
  }
  const loading = report.cases.find((entry) => entry.name === 'crop: A to B cold real navigation/loader rebase');
  if (loading) {
    const navigate = loading.steps.find((step) => step.name === 'navigate to B cold');
    const enter = loading.steps.find((step) => step.name === 'loading Enter cannot close session');
    add('new-image-not-ready', 'selectedImage.isReady', false, [{ entry: loading, steps: [navigate, enter] }], {
      applyDisabled: navigate?.dom?.applyDisabled === true && enter?.before.selectedImage?.isReady === false,
      cancelDisabled: navigate?.dom?.cancelDisabled === true,
      enterBlocked: passed(enter) && sameMode(enter) && unchanged(enter),
      toolDataUnchanged: unchanged(enter),
      modeUnchanged: sameMode(enter),
    });
  }
  const prompt = report.cases.find((entry) => entry.name === 'AI prompt focused: measured shared apply isolation');
  if (prompt) {
    const input = prompt.steps.find((step) => step.name === 'trusted prompt input and Enter with V8 call counts');
    const coverage = input?.applyCoverage;
    const inputs = input?.trace.filter((event) => event.kind === 'input') ?? [];
    add(
      'ai-prompt-enter',
      'prompt-focused',
      true,
      [{ entry: prompt, steps: [input] }],
      {
        inputFocused:
          input?.dom?.inputFocused === true &&
          ['keydown', 'keyup'].every((type) =>
            inputs.some((event) => event.type === type && event.code === 'Enter' && event.tag === 'TEXTAREA'),
          ),
        modeUnchanged: sameMode(input),
        sharedApplyNotCalled:
          !!coverage &&
          coverage.observedCallCount === 0 &&
          coverage.rawScript.scriptId === coverage.calibrationScript.scriptId &&
          coverage.calibrationScript.functions.some(
            (fn) => fn.functionName === 'applyToolSession' && fn.ranges.some((range) => range.count > 0),
          ) &&
          coverage.functions.every((fn) => fn.ranges.every((range) => range.count === 0)),
        nativeGenerationNotInvoked:
          !!input &&
          input.trace.every((event) => event.kind !== 'hostMock' || !String(event.cmd).startsWith('generate_')),
      },
      'browser-mocked-generation',
    );
  }
  const missing = required.filter((name) => !rows.some((row) => row.name === name));
  return {
    schema: 1,
    notnativegeneration: true,
    sourceInputDigest: report.provenance.before.digest,
    complete: missing.length === 0 && rows.every((row) => row.passed),
    missing,
    cases: rows,
  };
}
