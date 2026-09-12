export async function postFileTo(url, fields, token = "", options = {}) {
  const fd = new FormData();

  for (const [k, v] of Object.entries(fields || {})) {
    if (k === "file" || k === "filename") continue;
    if (v !== undefined && v !== null) fd.append(k, String(v));
  }

  if (fields.file instanceof Blob) {
    fd.append("file", fields.file, fields.filename || "file.csv");
  } else if (typeof fields.file === "string") {
    fd.append("file", new Blob([fields.file], { type: "text/plain" }), fields.filename || "file.txt");
  } else if (fields.file && typeof fields.file.text === "string") {
    fd.append("file", new Blob([fields.file.text], { type: "text/plain" }), fields.file.name || "file.txt");
  } else {
    throw new Error("postFileTo: file missing");
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
    },
    body: fd,
  });
  const body = await readBackendResponse(res);
  if (!res.ok) {
    const message = body?.error?.message || body?.error || body?.message || body?.raw || "";
    throw new Error(`Backend ${res.status}${message ? `: ${message}` : ""}`);
  }
  return body || { ok: true };
}

export async function getJson(url, token = "") {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await readBackendResponse(res);
  if (!res.ok) {
    const message = body?.error?.message || body?.error?.code || body?.error || body?.message || body?.raw || "";
    throw new Error(`Backend ${res.status}${message ? `: ${message}` : ""}`);
  }
  return body || { ok: true };
}

async function readBackendResponse(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { raw: text };
  }
}

export async function postOrderImport({ url, token, formData }) {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });
  const body = await readBackendResponse(res);
  if (!res.ok) {
    const message = body?.error || body?.message || body?.raw || "";
    throw new Error(`Backend ${res.status}${message ? `: ${message}` : ""}`);
  }
  return body || { ok: true };
}
