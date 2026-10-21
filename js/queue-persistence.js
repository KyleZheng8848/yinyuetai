/* Only queue metadata is stored here. Audio Blobs remain in the IndexedDB track store. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.QueuePersistence = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const VERSION = 1;
  const KEEP = 60;

  function serialize(jobs) {
    const rows = (Array.isArray(jobs) ? jobs : []).slice(-KEEP).map((job) => {
      const { model, params, ...metadata } = job;
      const safeParams = { ...(params || {}) };
      delete safeParams.referenceBlob;
      delete safeParams.continuityReferenceBlob;
      delete safeParams.continuityReferenceFilename;
      return { ...metadata, modelId: model?.id || '', params: safeParams };
    }).filter((job) => job.id && job.modelId);
    return JSON.stringify({ version: VERSION, savedAt: Date.now(), jobs: rows });
  }

  function restore(value, byId) {
    let parsed;
    try { parsed = JSON.parse(String(value || '')); }
    catch { return { jobs: [], savedAt: 0 }; }
    if (parsed?.version !== VERSION || !Array.isArray(parsed.jobs)) return { jobs: [], savedAt: 0 };
    const jobs = parsed.jobs.slice(-KEEP).map((row) => {
      if (!row || typeof row !== 'object' || !row.id || !row.modelId) return null;
      const model = byId(row.modelId);
      if (!model) return null;
      const { modelId, ...metadata } = row;
      const interrupted = ['running', 'stopping'].includes(metadata.status);
      return {
        ...metadata,
        model,
        params: { ...(metadata.params || {}) },
        status: interrupted ? 'interrupted' : metadata.status,
        error: interrupted ? '上次退出时生成正在运行；该段已中断，请重试' : String(metadata.error || ''),
        stopRequested: false,
        suiteAssembling: false,
        restored: true,
      };
    }).filter(Boolean);
    return { jobs, savedAt: Number(parsed.savedAt) || 0 };
  }

  return { VERSION, KEEP, serialize, restore };
});
