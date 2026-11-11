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

      // Find the file input in the active section
      const fileInputs = [...document.querySelectorAll('input[type="file"]')];
      const input = fileInputs.find((el) => el.offsetParent !== null) || document.querySelector('#fileToUpload') || fileInputs[0];
      if (!(input instanceof HTMLInputElement)) throw new Error('Seller Central upload controls are unavailable');

      // Populate file via DataTransfer
      const transfer = new DataTransfer();
      transfer.items.add(new File([content], name, { type: 'text/tab-separated-values' }));
      input.files = transfer.files;

      // Trigger standard and jQuery events
      input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));

      // Give browser UI and Amazon AUI JS 1200ms to reflect the selected file and enable Upload now
      await new Promise((r) => setTimeout(r, 1200));

      const form = input.form || input.closest('form');
      const searchScope = form || document;
      const candidates = [
        ...searchScope.querySelectorAll('input[type="submit"], button[type="submit"], .a-button-input, .a-button-text, button, input[type="button"], input')
      ];

      let submit = candidates.find((el) => {
        const text = (el.value || el.innerText || el.getAttribute('aria-label') || '').trim().toLowerCase();
        return text === 'upload now' || text === 'upload';
      });

      if (!submit) {
        submit = searchScope.querySelector('input[name="upload"], button[name="upload"], input[type="submit"], button[type="submit"]');
      }

      if (!submit) throw new Error('Seller Central upload button is unavailable');

      // Unlock Amazon AUI button container if disabled
      const auiContainer = submit.closest('.a-button');
      if (auiContainer) auiContainer.classList.remove('a-button-disabled');
      if ('disabled' in submit) submit.disabled = false;
      submit.removeAttribute('disabled');
      submit.removeAttribute('aria-disabled');

      // Click the button
      submit.click();
      if (auiContainer) {
        const auiInput = auiContainer.querySelector('input.a-button-input, input[type="submit"]');
        if (auiInput && auiInput !== submit) {
          auiInput.removeAttribute('disabled');
          auiInput.click();
        }
      }

      // Fallback: trigger form requestSubmit if available
      if (form && typeof form.requestSubmit === 'function') {
        try {
          form.requestSubmit(submit instanceof HTMLInputElement || submit instanceof HTMLButtonElement ? submit : undefined);
        } catch {}
      }

      return {
        acknowledged: true,
        inputFound: !!input,
        filesCount: input.files?.length || 0,
        buttonText: submit.value || submit.innerText || submit.name || 'Upload now',
      };
    },
  });
  return result?.result || { acknowledged: false };
}
