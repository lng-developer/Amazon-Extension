export async function postFileTo(url, fields, token = "") {
  const fd = new FormData();

  for (const [k, v] of Object.entries(fields || {})) {
    if (k === "file" || k === "filename") continue;
    if (v !== undefined && v !== null) fd.append(k, String(v));
  }

  if (typeof fields.file === "string") {
    fd.append("file", new Blob([fields.file], { type: "text/plain" }), fields.filename || "file.txt");
  } else if (fields.file && typeof fields.file.text === "string") {
    fd.append("file", new Blob([fields.file.text], { type: "text/plain" }), fields.file.name || "file.txt");
  } else {
    throw new Error("postFileTo: file missing");
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  if (!res.ok) throw new Error(`Backend ${res.status}`);
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  return ct.includes("application/json") ? res.json() : { ok: true, raw: await res.text() };
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
