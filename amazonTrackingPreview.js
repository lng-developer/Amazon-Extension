const TRACKING_COLUMNS = ['order-id', 'ship-date', 'carrier-code', 'tracking-number', 'ship-method'];

export function parseTrackingPreview(tsv) {
  const lines = String(tsv || '').trim().split(/\r?\n/).filter(Boolean);
  const headers = lines.shift()?.split('\t') || [];
  if (TRACKING_COLUMNS.some((column) => !headers.includes(column))) throw new Error('Tracking preview is missing required columns');
  return {
    columns: TRACKING_COLUMNS,
    rows: lines.map((line) => {
      const values = line.split('\t');
      return Object.fromEntries(TRACKING_COLUMNS.map((column) => [column, values[headers.indexOf(column)] || '']));
    }),
  };
}

export async function confirmTrackingPreview({ tsv, filename, checksum, rowCount, tabId }) {
  const preview = parseTrackingPreview(tsv);
  if (preview.rows.length !== Number(rowCount)) throw new Error('Tracking preview row count does not match payload');
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [{ ...preview, filename, checksum: String(checksum || '').slice(0, 12), rowCount }],
    func: (data) => new Promise((resolve) => {
      document.getElementById('lng-tracking-preview')?.remove();
      const make = (tag, text = '', attributes = {}) => {
        const element = document.createElement(tag);
        element.textContent = text;
        Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value));
        return element;
      };
      const overlay = make('div', '', { id: 'lng-tracking-preview', role: 'presentation' });
      overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(15,23,42,.55);display:grid;place-items:center;padding:24px;font-family:Arial,sans-serif;color:#172033;';
      const dialog = make('section', '', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'lng-tracking-preview-title' });
      dialog.style.cssText = 'width:min(1120px,96vw);max-height:88vh;overflow:hidden;background:#fff;border-radius:14px;box-shadow:0 24px 72px rgba(15,23,42,.35);display:flex;flex-direction:column;';
      const header = make('header');
      header.style.cssText = 'padding:20px 24px 16px;border-bottom:1px solid #e2e8f0;';
      header.append(make('h2', 'Xác nhận tracking trước khi upload', { id: 'lng-tracking-preview-title' }));
      header.lastChild.style.cssText = 'margin:0 0 6px;font-size:18px;';
      header.append(make('p', `${data.rowCount} dòng · ${data.filename} · checksum ${data.checksum}…`));
      header.lastChild.style.cssText = 'margin:0;color:#526075;font-size:13px;';
      const notice = make('p', 'Kiểm tra dữ liệu bên dưới. Chỉ khi bạn xác nhận, extension mới gửi file này lên Amazon.');
      notice.style.cssText = 'margin:16px 24px 10px;padding:10px 12px;background:#eff6ff;border-left:3px solid #2563eb;color:#1e3a5f;font-size:13px;';
      const scroll = make('div');
      scroll.style.cssText = 'overflow:auto;padding:0 24px 16px;';
      const table = make('table');
      table.style.cssText = 'width:100%;border-collapse:collapse;font-size:13px;white-space:nowrap;';
      const head = make('thead'); const headRow = make('tr');
      data.columns.forEach((column) => { const cell = make('th', column); cell.style.cssText = 'position:sticky;top:0;background:#f8fafc;text-align:left;padding:10px;border-bottom:1px solid #cbd5e1;color:#475569;'; headRow.append(cell); });
      head.append(headRow); table.append(head);
      const body = make('tbody');
      data.rows.forEach((row) => { const rowElement = make('tr'); data.columns.forEach((column) => { const cell = make('td', row[column]); cell.style.cssText = 'padding:10px;border-bottom:1px solid #e2e8f0;max-width:260px;overflow:hidden;text-overflow:ellipsis;'; rowElement.append(cell); }); body.append(rowElement); });
      table.append(body); scroll.append(table);
      const footer = make('footer'); footer.style.cssText = 'display:flex;justify-content:flex-end;gap:10px;padding:16px 24px;border-top:1px solid #e2e8f0;';
      const later = make('button', 'Để sau', { type: 'button' });
      const submit = make('button', `Upload ${data.rowCount} dòng lên Amazon`, { type: 'button' });
      later.style.cssText = 'border:1px solid #94a3b8;background:#fff;border-radius:7px;padding:10px 14px;cursor:pointer;';
      submit.style.cssText = 'border:0;background:#166534;color:#fff;border-radius:7px;padding:10px 14px;font-weight:700;cursor:pointer;';
      const finish = (approved) => { overlay.remove(); resolve({ approved }); };
      later.addEventListener('click', () => finish(false)); submit.addEventListener('click', () => finish(true));
      dialog.append(header, notice, scroll, footer); footer.append(later, submit); overlay.append(dialog); document.body.append(overlay); submit.focus();
    }),
  });
  return result?.result || { approved: false };
}
