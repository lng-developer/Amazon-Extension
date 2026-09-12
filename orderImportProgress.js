export const ORDER_IMPORT_PROGRESS_KEY = 'orderImportProgress';

export function createOrderImportProgress(state, message, details = {}) {
  return { state, message, ...details, updatedAt: Date.now() };
}
