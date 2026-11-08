import { useCallback, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'react-toastify';
import { useEditorStore } from '../store/useEditorStore';
import { useProcessStore, type AiTask } from '../store/useProcessStore';
import { useEditorActions } from './useEditorActions';
import { useCloudStore } from '../store/useCloudStore';
import { Adjustments, AiPatch, MaskContainer, Coord } from '../utils/adjustments';
import { SubMask } from '../components/panel/right/Masks';
import { Invokes } from '../components/ui/AppProperties';
import { isHistoryMode } from '../utils/appMode';
import { globalImageCache } from '../utils/ImageLRUCache';

interface AiRequest {
  id: string;
  path: string;
  imageGeneration: number;
  historyRevision: number;
  guarded: boolean;
  task?: AiTask;
  patchId?: string;
  subMaskId?: string;
}

// Shared by the canvas and panel hook instances, including their cancel handlers.
const pendingRequests = new Map<string, AiRequest>();
const cancelledRequests = new WeakSet<AiRequest>();
let imageGeneration = 0;
useEditorStore.subscribe((state, previous) => {
  if (state.selectedImage?.path !== previous.selectedImage?.path) imageGeneration++;
});

const findSubMask = (adjustments: Adjustments, id: string) =>
  adjustments.masks?.flatMap((mask) => mask.subMasks).find((mask) => mask.id === id) ||
  adjustments.aiPatches?.flatMap((patch) => patch.subMasks).find((mask) => mask.id === id);

const ownsRequest = (request: AiRequest) =>
  !request.guarded ||
  (pendingRequests.get(request.id) === request &&
    (!request.task || useProcessStore.getState().activeAiTasks[request.id] === request.task));

const isRequestImage = (request: AiRequest) =>
  !request.guarded ||
  (request.imageGeneration === imageGeneration &&
    useEditorStore.getState().selectedImage?.path === request.path &&
    useEditorStore.getState().historyRevision === request.historyRevision);

const withoutRequestLoading = (request: AiRequest, adjustments: Adjustments): Adjustments => {
  if (!request.patchId || !adjustments.aiPatches?.some((patch) => patch.id === request.patchId && patch.isLoading)) {
    return adjustments;
  }
  return {
    ...adjustments,
    aiPatches: adjustments.aiPatches.map((patch) =>
      patch.id === request.patchId ? { ...patch, isLoading: false } : patch,
    ),
  };
};

const isCurrentRequest = (request: AiRequest, adjustments = useEditorStore.getState().adjustments) => {
  if (!request.guarded) return true;
  if (!ownsRequest(request) || cancelledRequests.has(request) || !isRequestImage(request)) return false;
  if (request.patchId) {
    const patch = adjustments.aiPatches?.find((patch) => patch.id === request.patchId);
    return !!patch && (!request.subMaskId || patch.subMasks.some((mask) => mask.id === request.subMaskId));
  }
  return !!request.subMaskId && !!findSubMask(adjustments, request.subMaskId);
};

const beginRequest = (
  id: string,
  path: string,
  type: string | null,
  target: Pick<AiRequest, 'patchId' | 'subMaskId'>,
) => {
  const request: AiRequest = {
    id,
    path,
    imageGeneration,
    historyRevision: useEditorStore.getState().historyRevision,
    guarded: isHistoryMode(),
    ...target,
  };
  if (type) {
    useProcessStore.getState().registerAiTask(id, type);
    request.task = useProcessStore.getState().activeAiTasks[id];
  }
  if (request.guarded) pendingRequests.set(id, request);
  return request;
};

const getTransformAdjustments = (adj: Adjustments) => ({
  transformDistortion: adj.transformDistortion,
  transformVertical: adj.transformVertical,
  transformHorizontal: adj.transformHorizontal,
  transformRotate: adj.transformRotate,
  transformAspect: adj.transformAspect,
  transformScale: adj.transformScale,
  transformXOffset: adj.transformXOffset,
  transformYOffset: adj.transformYOffset,
  lensDistortionAmount: adj.lensDistortionAmount,
  lensVignetteAmount: adj.lensVignetteAmount,
  lensTcaAmount: adj.lensTcaAmount,
  lensCorrectionMode: adj.lensCorrectionMode,
  lensMaker: adj.lensMaker,
  lensModel: adj.lensModel,
  lensDistortionEnabled: adj.lensDistortionEnabled,
  lensTcaEnabled: adj.lensTcaEnabled,
  lensVignetteEnabled: adj.lensVignetteEnabled,
});

export function useAiMasking() {
  const { setAdjustments } = useEditorActions();
  const setEditor = useEditorStore((state) => state.setEditor);
  const getToken = useCloudStore((s) => s.getToken);
  const setRequestAdjustments = useCallback(
    (request: AiRequest, update: (previous: Adjustments) => Adjustments) =>
      setAdjustments((previous) => (isCurrentRequest(request, previous) ? update(previous) : previous)),
    [setAdjustments],
  );

  const finishRequest = useCallback(
    (request: AiRequest) => {
      if (ownsRequest(request) && isRequestImage(request)) {
        if (request.guarded || !request.task) useEditorStore.getState().patchesSentToBackend.delete(request.id);
      }
      // Results need the original image/revision. Loading cleanup only needs ownership
      // and the same path, including a cached image revisited while this request ran.
      if (request.patchId && ownsRequest(request)) {
        if (!request.guarded || useEditorStore.getState().selectedImage?.path === request.path) {
          setAdjustments((previous) => {
            if (!ownsRequest(request)) return previous;
            if (request.guarded && useEditorStore.getState().selectedImage?.path !== request.path) return previous;
            return withoutRequestLoading(request, previous);
          });
        }
        if (request.guarded && ownsRequest(request)) {
          const cached = globalImageCache.get(request.path);
          if (cached) {
            const adjustments = withoutRequestLoading(request, cached.adjustments);
            // get() releases blob protection; set() restores it even when no flag changed.
            globalImageCache.set(
              request.path,
              adjustments === cached.adjustments ? cached : { ...cached, adjustments },
            );
          }
        }
      }
      // A replaced request must not release a newer task with the same ID.
      if (request.task && (!request.guarded || useProcessStore.getState().activeAiTasks[request.id] === request.task)) {
        useProcessStore.getState().unregisterAiTask(request.id);
      }
      if (request.guarded && pendingRequests.get(request.id) === request) pendingRequests.delete(request.id);
    },
    [setAdjustments],
  );

  const updateSubMask = useCallback(
    (subMaskId: string, updatedData: any) => {
      setAdjustments((prev: Adjustments) => ({
        ...prev,
        masks: prev.masks.map((c: MaskContainer) => ({
          ...c,
          subMasks: c.subMasks.map((sm: SubMask) => (sm.id === subMaskId ? { ...sm, ...updatedData } : sm)),
        })),
        aiPatches: (prev.aiPatches || []).map((p: AiPatch) => ({
          ...p,
          subMasks: p.subMasks.map((sm: SubMask) => (sm.id === subMaskId ? { ...sm, ...updatedData } : sm)),
        })),
      }));
    },
    [setAdjustments],
  );

  const handleCancelAiTask = useCallback(
    async (taskId: string) => {
      const guarded = isHistoryMode();
      const request = pendingRequests.get(taskId);
      const owned = !!request && ownsRequest(request);
      if (guarded && owned) cancelledRequests.add(request);
      const editor = useEditorStore.getState();
      const orphan =
        guarded && !owned
          ? { path: editor.selectedImage?.path, imageGeneration, historyRevision: editor.historyRevision }
          : null;
      const relatedIds = new Set([taskId]);
      if (orphan) {
        for (const patch of editor.adjustments.aiPatches || []) {
          if (patch.id === taskId || patch.subMasks.some((mask) => mask.id === taskId)) {
            relatedIds.add(patch.id);
            patch.subMasks.forEach((mask) => relatedIds.add(mask.id));
          }
        }
      }
      const slots = [...relatedIds].map((id) => ({
        id,
        request: pendingRequests.get(id),
        task: useProcessStore.getState().activeAiTasks[id],
      }));
      const canRecoverOrphan = () =>
        orphan?.path != null &&
        orphan.path === useEditorStore.getState().selectedImage?.path &&
        orphan.imageGeneration === imageGeneration &&
        orphan.historyRevision === useEditorStore.getState().historyRevision &&
        slots.every(
          (slot) =>
            pendingRequests.get(slot.id) === slot.request &&
            useProcessStore.getState().activeAiTasks[slot.id] === slot.task &&
            (!slot.request || !ownsRequest(slot.request)),
        );
      try {
        await invoke(Invokes.CancelAiTask, { taskId });
      } catch (e) {
        console.error('Failed to cancel AI task:', e);
      } finally {
        if (!guarded) {
          useProcessStore.getState().unregisterAiTask(taskId);
          setAdjustments((prev) => ({
            ...prev,
            aiPatches: (prev.aiPatches || []).map((patch) =>
              patch.id === taskId || patch.subMasks.some((mask) => mask.id === taskId)
                ? { ...patch, isLoading: false }
                : patch,
            ),
          }));
        } else if (canRecoverOrphan()) {
          // Legacy metadata can contain loading without a local request. Preserve
          // the panel's recovery action, but never clear a request started meanwhile.
          setAdjustments((prev) => {
            if (!canRecoverOrphan()) return prev;
            const matches = (patch: AiPatch) =>
              patch.isLoading && (patch.id === taskId || patch.subMasks.some((mask) => mask.id === taskId));
            if (!prev.aiPatches?.some(matches)) return prev;
            return {
              ...prev,
              aiPatches: prev.aiPatches.map((patch) => (matches(patch) ? { ...patch, isLoading: false } : patch)),
            };
          });
          const slot = slots.find((slot) => slot.id === taskId);
          if (slot?.task && canRecoverOrphan()) useProcessStore.getState().unregisterAiTask(taskId);
        }
      }
      // Keep busy until the original request settles; its finally owns cleanup.
    },
    [setAdjustments],
  );

  const handleDirectPatch = useCallback(
    async (subMaskId: string, source: Coord | null = null, sourceVariant: number = 0) => {
      const { selectedImage, adjustments, patchesSentToBackend } = useEditorStore.getState();
      if (!selectedImage?.path) return;

      const patchDefinitionForBackend = adjustments.aiPatches?.find((p: AiPatch) =>
        p.subMasks.some((sm: SubMask) => sm.id === subMaskId),
      );
      if (!patchDefinitionForBackend) return;
      const patchId = patchDefinitionForBackend.id;
      const request = beginRequest(patchId, selectedImage.path, isHistoryMode() ? 'manual-patch' : null, {
        patchId,
        subMaskId,
      });
      const previousParameters = patchDefinitionForBackend.subMasks.find(
        (sm: SubMask) => sm.id === subMaskId,
      )?.parameters;

      try {
        patchesSentToBackend.add(patchId);
        setRequestAdjustments(request, (prev) => ({
          ...prev,
          aiPatches: prev.aiPatches.map((p) => (p.id === patchId ? { ...p, isLoading: true } : p)),
        }));
        if (!isCurrentRequest(request)) return;
        const isLiquify = patchDefinitionForBackend.subMasks.some((sm: SubMask) => sm.type === 'liquify');
        const isRetouch = patchDefinitionForBackend.subMasks.some((sm: SubMask) => sm.type === 'retouch');
        const command = isLiquify
          ? 'generate_liquify_patch'
          : isRetouch
            ? 'generate_retouch_patch'
            : 'generate_manual_cleanup_patch';

        const newPatchDataJson: any = await invoke(command, {
          currentAdjustments: adjustments,
          patchDefinition: patchDefinitionForBackend,
          sourcePoint: source ? [source.x, source.y] : null,
          sourceVariant,
        });

        if (!isCurrentRequest(request)) return;
        const { sourceX, sourceY, ...newPatchData } = JSON.parse(newPatchDataJson);
        patchesSentToBackend.delete(patchId);

        const adoptPickedSource = (sm: SubMask) =>
          sourceX !== undefined &&
          sm.id === subMaskId &&
          sm.parameters?.sourceX === previousParameters?.sourceX &&
          sm.parameters?.sourceY === previousParameters?.sourceY;

        setRequestAdjustments(request, (prev) => ({
          ...prev,
          aiPatches: prev.aiPatches?.map((p: AiPatch) =>
            p.id === patchId
              ? {
                  ...p,
                  patchData: newPatchData,
                  isLoading: false,
                  subMasks: p.subMasks.map((sm: SubMask) =>
                    adoptPickedSource(sm)
                      ? { ...sm, parameters: { ...sm.parameters, sourceX, sourceY, sourceVariant } }
                      : sm,
                  ),
                }
              : p,
          ),
        }));
      } catch (err: any) {
        if (isCurrentRequest(request) && !String(err).includes('cancelled')) {
          toast.error(`Patch Generation Failed: ${err.message || String(err)}`);
        }
      } finally {
        finishRequest(request);
      }
    },
    [setRequestAdjustments, finishRequest],
  );

  const handleGenerativeReplace = useCallback(
    async (patchId: string, prompt: string, useFastInpaint: boolean) => {
      const { selectedImage, adjustments, patchesSentToBackend } = useEditorStore.getState();
      if (!selectedImage?.path) return;

      const patch: AiPatch | undefined = adjustments.aiPatches?.find((p: AiPatch) => p.id === patchId);
      if (!patch) return;

      const patchDefinition = { ...patch, prompt };
      // Android keeps its original token-before-registration timing.
      const earlyToken = isHistoryMode() ? undefined : await getToken();
      const request = beginRequest(patchId, selectedImage.path, 'inpaint', { patchId });

      try {
        setRequestAdjustments(request, (prev) => ({
          ...prev,
          aiPatches: prev.aiPatches.map((p) => (p.id === patchId ? { ...p, isLoading: true, prompt } : p)),
        }));
        const token = request.guarded ? await getToken() : earlyToken;
        if (!isCurrentRequest(request)) return;
        const newPatchDataJson: any = await invoke(Invokes.InvokeGenerativeReplaseWithMaskDef, {
          currentAdjustments: adjustments,
          patchDefinition: patchDefinition,
          path: selectedImage.path,
          useFastInpaint: useFastInpaint,
          token: token || null,
          taskId: patchId,
        });

        if (!isCurrentRequest(request)) return;
        const newPatchData = JSON.parse(newPatchDataJson);
        patchesSentToBackend.delete(patchId);

        setRequestAdjustments(request, (prev) => ({
          ...prev,
          aiPatches: prev.aiPatches.map((p: AiPatch) =>
            p.id === patchId
              ? {
                  ...p,
                  patchData: newPatchData,
                  isLoading: false,
                  name: useFastInpaint ? 'Inpaint' : prompt && prompt.trim() ? prompt.trim() : p.name,
                }
              : p,
          ),
        }));
        if (isCurrentRequest(request)) setEditor({ activeAiPatchContainerId: null, activeAiSubMaskId: null });
        if (!useFastInpaint && isCurrentRequest(request)) {
          useCloudStore.getState().fetchUsage();
        }
      } catch (err: any) {
        if (isCurrentRequest(request) && !String(err).includes('cancelled')) {
          toast.error(`AI Replace Failed: ${err}`);
        }
      } finally {
        finishRequest(request);
      }
    },
    [setRequestAdjustments, getToken, finishRequest, setEditor],
  );

  const handleQuickErase = useCallback(
    async (subMaskId: string | null, startPoint: Coord, endPoint: Coord) => {
      const { selectedImage, adjustments, patchesSentToBackend } = useEditorStore.getState();
      if (!selectedImage?.path || (isHistoryMode() && !subMaskId)) return;
      const earlyToken = isHistoryMode() ? undefined : await getToken();

      const patchId = adjustments.aiPatches?.find((p: AiPatch) =>
        p.subMasks.some((sm: SubMask) => sm.id === subMaskId),
      )?.id;
      if (!patchId) return;

      const request = beginRequest(patchId, selectedImage.path, 'inpaint', {
        patchId,
        subMaskId: subMaskId ?? undefined,
      });

      try {
        setRequestAdjustments(request, (prev) => ({
          ...prev,
          aiPatches: prev.aiPatches.map((p) => (p.id === patchId ? { ...p, isLoading: true } : p)),
        }));
        const token = request.guarded ? await getToken() : earlyToken;
        if (!isCurrentRequest(request)) return;
        const transformAdjustments = getTransformAdjustments(adjustments);
        const newMaskParams: any = await invoke(Invokes.GenerateAiSubjectMask, {
          jsAdjustments: transformAdjustments,
          endPoint: [endPoint.x, endPoint.y],
          flipHorizontal: adjustments.flipHorizontal,
          flipVertical: adjustments.flipVertical,
          orientationSteps: adjustments.orientationSteps,
          path: selectedImage.path,
          rotation: adjustments.rotation,
          startPoint: [startPoint.x, startPoint.y],
          skipRefinement: true,
          taskId: patchId,
        });

        if (!isCurrentRequest(request)) return;
        const subMaskToUpdate = adjustments.aiPatches
          ?.find((p: AiPatch) => p.id === patchId)
          ?.subMasks.find((sm: SubMask) => sm.id === subMaskId);
        const finalSubMaskParams: any = { ...subMaskToUpdate?.parameters, ...newMaskParams };
        const updatedAdjustmentsForBackend = {
          ...adjustments,
          aiPatches: adjustments.aiPatches.map((p: AiPatch) =>
            p.id === patchId
              ? {
                  ...p,
                  subMasks: p.subMasks.map((sm: SubMask) =>
                    sm.id === subMaskId ? { ...sm, parameters: finalSubMaskParams } : sm,
                  ),
                }
              : p,
          ),
        };

        const patchDefinitionForBackend = updatedAdjustmentsForBackend.aiPatches.find((p: AiPatch) => p.id === patchId);
        const newPatchDataJson: any = await invoke(Invokes.InvokeGenerativeReplaseWithMaskDef, {
          currentAdjustments: updatedAdjustmentsForBackend,
          patchDefinition: { ...patchDefinitionForBackend, prompt: '' },
          path: selectedImage.path,
          useFastInpaint: true,
          token: token || null,
          taskId: patchId,
        });

        if (!isCurrentRequest(request)) return;
        const newPatchData = JSON.parse(newPatchDataJson);
        patchesSentToBackend.delete(patchId);

        setRequestAdjustments(request, (prev) => ({
          ...prev,
          aiPatches: prev.aiPatches?.map((p: AiPatch) =>
            p.id === patchId
              ? {
                  ...p,
                  patchData: newPatchData,
                  isLoading: false,
                  subMasks: p.subMasks.map((sm: SubMask) =>
                    sm.id === subMaskId ? { ...sm, parameters: finalSubMaskParams } : sm,
                  ),
                }
              : p,
          ),
        }));
        if (isCurrentRequest(request)) setEditor({ activeAiPatchContainerId: null, activeAiSubMaskId: null });
      } catch (err: any) {
        if (isCurrentRequest(request) && !String(err).includes('cancelled')) {
          toast.error(`Quick Erase Failed: ${err.message || String(err)}`);
        }
      } finally {
        finishRequest(request);
      }
    },
    [setRequestAdjustments, getToken, finishRequest, setEditor],
  );

  const handleDeleteMaskContainer = useCallback(
    (containerId: string) => {
      const { activeMaskContainerId } = useEditorStore.getState();
      setAdjustments((prev: Adjustments) => ({
        ...prev,
        masks: (prev.masks || []).filter((c) => c.id !== containerId),
      }));
      if (activeMaskContainerId === containerId) {
        setEditor({ activeMaskContainerId: null, activeMaskId: null });
      }
    },
    [setAdjustments, setEditor],
  );

  const handleDeleteAiPatch = useCallback(
    (patchId: string) => {
      const { activeAiPatchContainerId } = useEditorStore.getState();
      setAdjustments((prev: Adjustments) => ({
        ...prev,
        aiPatches: (prev.aiPatches || []).filter((p) => p.id !== patchId),
      }));
      if (activeAiPatchContainerId === patchId) {
        setEditor({ activeAiPatchContainerId: null, activeAiSubMaskId: null });
      }
    },
    [setAdjustments, setEditor],
  );

  const handleToggleAiPatchVisibility = useCallback(
    (patchId: string) => {
      setAdjustments((prev: Adjustments) => ({
        ...prev,
        aiPatches: (prev.aiPatches || []).map((p: AiPatch) => (p.id === patchId ? { ...p, visible: !p.visible } : p)),
      }));
    },
    [setAdjustments],
  );

  const handleGenerateAiMask = async (subMaskId: string, startPoint: Coord, endPoint: Coord) => {
    const { selectedImage, adjustments, patchesSentToBackend } = useEditorStore.getState();
    if (!selectedImage?.path || (isHistoryMode() && !findSubMask(adjustments, subMaskId))) return;
    const request = beginRequest(subMaskId, selectedImage.path, 'subject', { subMaskId });

    try {
      if (!isCurrentRequest(request)) return;
      const transformAdjustments = getTransformAdjustments(adjustments);
      const isInpaintMask = !!adjustments.aiPatches?.some((p: AiPatch) =>
        p.subMasks.some((sm: SubMask) => sm.id === subMaskId),
      );
      const newParameters = await invoke<Record<string, unknown>>(Invokes.GenerateAiSubjectMask, {
        jsAdjustments: transformAdjustments,
        endPoint: [endPoint.x, endPoint.y],
        flipHorizontal: adjustments.flipHorizontal,
        flipVertical: adjustments.flipVertical,
        orientationSteps: adjustments.orientationSteps,
        path: selectedImage.path,
        rotation: adjustments.rotation,
        startPoint: [startPoint.x, startPoint.y],
        skipRefinement: isInpaintMask,
        taskId: subMaskId,
      });

      if (!isCurrentRequest(request)) return;
      const subMask =
        adjustments.masks?.flatMap((m: MaskContainer) => m.subMasks).find((sm: SubMask) => sm.id === subMaskId) ||
        adjustments.aiPatches?.flatMap((p: AiPatch) => p.subMasks).find((sm: SubMask) => sm.id === subMaskId);

      const mergedParameters = { ...(subMask?.parameters || {}), ...newParameters };
      patchesSentToBackend.delete(subMaskId);
      updateSubMask(subMaskId, { parameters: mergedParameters });
    } catch (error) {
      if (isCurrentRequest(request) && !String(error).includes('cancelled')) {
        toast.error(`AI Mask Failed: ${error}`);
      }
    } finally {
      finishRequest(request);
    }
  };

  const handleGenerateAiDepthMask = async (subMaskId: string, parameters: any) => {
    const { selectedImage, adjustments, patchesSentToBackend } = useEditorStore.getState();
    if (!selectedImage?.path || (isHistoryMode() && !findSubMask(adjustments, subMaskId))) return;
    const request = beginRequest(subMaskId, selectedImage.path, 'depth', { subMaskId });

    try {
      if (!isCurrentRequest(request)) return;
      const transformAdjustments = getTransformAdjustments(adjustments);
      const newParameters = await invoke<Record<string, unknown>>('generate_ai_depth_mask', {
        jsAdjustments: transformAdjustments,
        path: selectedImage.path,
        minDepth: parameters.minDepth ?? 20,
        maxDepth: parameters.maxDepth ?? 100,
        minFade: parameters.minFade ?? 15,
        maxFade: parameters.maxFade ?? 15,
        feather: parameters.feather ?? 10,
        flipHorizontal: adjustments.flipHorizontal,
        flipVertical: adjustments.flipVertical,
        orientationSteps: adjustments.orientationSteps,
        rotation: adjustments.rotation,
        taskId: subMaskId,
      });

      if (!isCurrentRequest(request)) return;
      const subMask =
        adjustments.masks?.flatMap((m: MaskContainer) => m.subMasks).find((sm: SubMask) => sm.id === subMaskId) ||
        adjustments.aiPatches?.flatMap((p: AiPatch) => p.subMasks).find((sm: SubMask) => sm.id === subMaskId);

      const mergedParameters = { ...(subMask?.parameters || {}), ...newParameters };
      patchesSentToBackend.delete(subMaskId);
      updateSubMask(subMaskId, { parameters: mergedParameters });
    } catch (error) {
      if (isCurrentRequest(request) && !String(error).includes('cancelled')) {
        toast.error(`AI Depth Mask Failed: ${error}`);
      }
    } finally {
      finishRequest(request);
    }
  };

  const handleGenerateAiForegroundMask = async (subMaskId: string) => {
    const { selectedImage, adjustments, patchesSentToBackend } = useEditorStore.getState();
    if (!selectedImage?.path || (isHistoryMode() && !findSubMask(adjustments, subMaskId))) return;
    const request = beginRequest(subMaskId, selectedImage.path, 'foreground', { subMaskId });

    try {
      if (!isCurrentRequest(request)) return;
      const transformAdjustments = getTransformAdjustments(adjustments);
      const { noResult, ...newParameters } = await invoke<Record<string, unknown>>(Invokes.GenerateAiForegroundMask, {
        jsAdjustments: transformAdjustments,
        flipHorizontal: adjustments.flipHorizontal,
        flipVertical: adjustments.flipVertical,
        orientationSteps: adjustments.orientationSteps,
        rotation: adjustments.rotation,
        taskId: subMaskId,
      });

      if (!isCurrentRequest(request)) return;
      const subMask =
        adjustments.masks?.flatMap((m: MaskContainer) => m.subMasks).find((sm: SubMask) => sm.id === subMaskId) ||
        adjustments.aiPatches?.flatMap((p: AiPatch) => p.subMasks).find((sm: SubMask) => sm.id === subMaskId);

      const mergedParameters = { ...(subMask?.parameters || {}), ...newParameters };
      patchesSentToBackend.delete(subMaskId);
      updateSubMask(subMaskId, { parameters: mergedParameters });
      if (noResult) toast.error(`AI Foreground Mask Failed: ${noResult}`);
    } catch (error) {
      if (isCurrentRequest(request) && !String(error).includes('cancelled')) {
        toast.error(`AI Foreground Mask Failed: ${error}`);
      }
    } finally {
      finishRequest(request);
    }
  };

  const handleGenerateAiSkyMask = async (subMaskId: string) => {
    const { selectedImage, adjustments, patchesSentToBackend } = useEditorStore.getState();
    if (!selectedImage?.path || (isHistoryMode() && !findSubMask(adjustments, subMaskId))) return;
    const request = beginRequest(subMaskId, selectedImage.path, 'sky', { subMaskId });

    try {
      if (!isCurrentRequest(request)) return;
      const transformAdjustments = getTransformAdjustments(adjustments);
      const { noResult, ...newParameters } = await invoke<Record<string, unknown>>(Invokes.GenerateAiSkyMask, {
        jsAdjustments: transformAdjustments,
        path: selectedImage.path,
        flipHorizontal: adjustments.flipHorizontal,
        flipVertical: adjustments.flipVertical,
        orientationSteps: adjustments.orientationSteps,
        rotation: adjustments.rotation,
        taskId: subMaskId,
      });

      if (!isCurrentRequest(request)) return;
      const subMask =
        adjustments.masks?.flatMap((m: MaskContainer) => m.subMasks).find((sm: SubMask) => sm.id === subMaskId) ||
        adjustments.aiPatches?.flatMap((p: AiPatch) => p.subMasks).find((sm: SubMask) => sm.id === subMaskId);

      const mergedParameters = { ...(subMask?.parameters || {}), ...newParameters };
      patchesSentToBackend.delete(subMaskId);
      updateSubMask(subMaskId, { parameters: mergedParameters });
      if (noResult) toast.error(`AI Sky Mask Failed: ${noResult}`);
    } catch (error) {
      if (isCurrentRequest(request) && !String(error).includes('cancelled')) {
        toast.error(`AI Sky Mask Failed: ${error}`);
      }
    } finally {
      finishRequest(request);
    }
  };

  const handleGenerateAiTextMask = async (subMaskId: string, prompt: string) => {
    const { selectedImage, adjustments, patchesSentToBackend } = useEditorStore.getState();
    if (!selectedImage?.path || !prompt.trim() || (isHistoryMode() && !findSubMask(adjustments, subMaskId))) return;
    const request = beginRequest(subMaskId, selectedImage.path, 'text', { subMaskId });

    try {
      if (!isCurrentRequest(request)) return;
      const transformAdjustments = getTransformAdjustments(adjustments);
      const { noResult, ...newParameters } = await invoke<Record<string, unknown>>(Invokes.GenerateAiTextMask, {
        jsAdjustments: transformAdjustments,
        path: selectedImage.path,
        prompt: prompt.trim(),
        flipHorizontal: adjustments.flipHorizontal,
        flipVertical: adjustments.flipVertical,
        orientationSteps: adjustments.orientationSteps,
        rotation: adjustments.rotation,
        taskId: subMaskId,
      });

      if (!isCurrentRequest(request)) return;
      const subMask =
        adjustments.masks?.flatMap((m: MaskContainer) => m.subMasks).find((sm: SubMask) => sm.id === subMaskId) ||
        adjustments.aiPatches?.flatMap((p: AiPatch) => p.subMasks).find((sm: SubMask) => sm.id === subMaskId);

      const mergedParameters = { ...(subMask?.parameters || {}), ...newParameters };
      patchesSentToBackend.delete(subMaskId);
      updateSubMask(subMaskId, { parameters: mergedParameters });
      if (noResult) toast.error(`AI Text Mask Failed: ${noResult}`);
    } catch (error) {
      if (isCurrentRequest(request) && !String(error).includes('cancelled')) {
        toast.error(`AI Text Mask Failed: ${error}`);
      }
    } finally {
      finishRequest(request);
    }
  };

  const handleGenerateAiFaceMask = async (subMaskId: string, parts: Array<string>) => {
    const { selectedImage, adjustments, patchesSentToBackend } = useEditorStore.getState();
    if (!selectedImage?.path || parts.length === 0 || (isHistoryMode() && !findSubMask(adjustments, subMaskId))) return;
    const request = beginRequest(subMaskId, selectedImage.path, 'face', { subMaskId });

    try {
      if (!isCurrentRequest(request)) return;
      const transformAdjustments = getTransformAdjustments(adjustments);
      const { noResult, ...newParameters } = await invoke<Record<string, unknown>>(Invokes.GenerateAiFaceMask, {
        jsAdjustments: transformAdjustments,
        path: selectedImage.path,
        parts,
        flipHorizontal: adjustments.flipHorizontal,
        flipVertical: adjustments.flipVertical,
        orientationSteps: adjustments.orientationSteps,
        rotation: adjustments.rotation,
        taskId: subMaskId,
      });

      if (!isCurrentRequest(request)) return;
      const latest = useEditorStore.getState().adjustments;
      const subMask =
        latest.masks?.flatMap((m: MaskContainer) => m.subMasks).find((sm: SubMask) => sm.id === subMaskId) ||
        latest.aiPatches?.flatMap((p: AiPatch) => p.subMasks).find((sm: SubMask) => sm.id === subMaskId);
      if (subMask?.parameters?.parts?.join() !== parts.join()) return;

      const mergedParameters = { ...subMask.parameters, ...newParameters };
      patchesSentToBackend.delete(subMaskId);
      updateSubMask(subMaskId, { parameters: mergedParameters });
      if (noResult) toast.error(`AI Face Mask Failed: ${noResult}`);
    } catch (error) {
      if (isCurrentRequest(request) && !String(error).includes('cancelled')) {
        toast.error(`AI Face Mask Failed: ${error}`);
      }
    } finally {
      finishRequest(request);
    }
  };

  useEffect(() => {
    const { activeMaskId, activeAiSubMaskId, adjustments, selectedImage } = useEditorStore.getState();
    const activeSubMask =
      adjustments?.masks?.flatMap((m: MaskContainer) => m.subMasks).find((sm: SubMask) => sm.id === activeMaskId) ||
      adjustments?.aiPatches?.flatMap((p: AiPatch) => p.subMasks).find((sm: SubMask) => sm.id === activeAiSubMaskId);

    if (activeSubMask?.type === 'ai-subject' && selectedImage?.path) {
      const transformAdjustments = getTransformAdjustments(adjustments);
      invoke('precompute_ai_subject_mask', {
        jsAdjustments: transformAdjustments,
        path: selectedImage.path,
      }).catch((err) => console.error('Failed to precompute AI subject mask:', err));
    }
  }, [
    useEditorStore.getState().activeMaskId,
    useEditorStore.getState().activeAiSubMaskId,
    useEditorStore.getState().selectedImage?.path,
  ]);

  return {
    updateSubMask,
    handleGenerativeReplace,
    handleDirectPatch,
    handleQuickErase,
    handleDeleteMaskContainer,
    handleDeleteAiPatch,
    handleToggleAiPatchVisibility,
    handleGenerateAiMask,
    handleGenerateAiDepthMask,
    handleGenerateAiForegroundMask,
    handleGenerateAiSkyMask,
    handleGenerateAiTextMask,
    handleGenerateAiFaceMask,
    handleCancelAiTask,
  };
}
