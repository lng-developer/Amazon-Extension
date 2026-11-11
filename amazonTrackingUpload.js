const REQUIRED_HEADERS = ['order-id', 'ship-date', 'carrier-code', 'tracking-number', 'ship-method'];

export async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function validateTrackingPayload({ tsv, checksum, rowCount }) {
  if (await sha256(tsv) !== checksum) throw new Error('Tracking TSV checksum mismatch');
  const lines = String(tsv).trim().split(/\r?\n/);
  const headers = lines[0]?.split('\t') || [];
  if (REQUIRED_HEADERS.some((header) => !headers.includes(header)) || lines.length - 1 !== Number(rowCount)) throw new Error('Tracking TSV is invalid');
  return { rows: lines.length - 1 };
}

export async function submitNativeTrackingFeed({ tsv, filename, tabId }) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN', args: [tsv, filename],
    func: async (content, name) => {
      if (document.querySelector('form[action*="signin"], input[name="password"], #ap_email, #auth-captcha-image')) {
        throw new Error('Seller Central login or CAPTCHA required');
      }
      const input = document.querySelector('#fileToUpload, input[type="file"]');
      const submit = document.querySelector('input[name="upload"][type="submit"], input[type="submit"], button[type="submit"]');
      if (!(input instanceof HTMLInputElement) || !(submit instanceof HTMLElement)) throw new Error('Seller Central upload controls are unavailable');
      const transfer = new DataTransfer();
      transfer.items.add(new File([content], name, { type: 'text/tab-separated-values' }));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('input', { bubbles: true }));

      // Give Amazon AUI JS 600ms to process the change event and enable the upload button
      await new Promise((r) => setTimeout(r, 600));

      const isSubmitDisabled = () => {
        if ('disabled' in submit && submit.disabled) return true;
        if (submit.getAttribute('disabled') !== null) return true;
        if (submit.classList.contains('a-button-disabled') || submit.closest('.a-button-disabled')) return true;
        return false;
      };

      if (isSubmitDisabled()) {
        submit.removeAttribute('disabled');
        submit.disabled = false;
        submit.closest('.a-button')?.classList.remove('a-button-disabled');
      }

      submit.click();
      return { acknowledged: true };
    },
  });
  return result?.result || { acknowledged: false };
}
