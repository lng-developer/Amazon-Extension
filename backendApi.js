import { deriveApiUrls } from "./config.js";

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
    headers: { "x-access-token": token || "" },
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

export async function postFbmImport({ url, token, formData }) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "x-access-token": token || "" },
    body: formData,
  });
  if (!res.ok) throw new Error(`Backend ${res.status}`);
  return (await readBackendResponse(res)) || { ok: true };
}

export async function fetchEmployeeCodesFromBackend({ ingestUrl }) {
  const { getSeller } = deriveApiUrls(ingestUrl);
  const response = await fetch(getSeller, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });
  return response.json();
}

export async function checkOrdersStatus({ ingestUrl, shopId, token }) {
  const { checkOrdersStatusUrl } = deriveApiUrls(ingestUrl);
  const url = `${checkOrdersStatusUrl}?machineId=${encodeURIComponent(shopId)}&limit=1000`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "x-access-token": token || "",
    },
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`uploadtracking API ${res.status}: ${errText.slice(0, 200)}`);
  }
  return res.json();
}

export async function createShippingBatch({ ingestUrl, token, payload }) {
  const { createShippingBatchUrl } = deriveApiUrls(ingestUrl);
  const res = await fetch(createShippingBatchUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-access-token": token || "",
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`create-from-orders ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

export async function postExtensionLog({ base, token, payload }) {
  const { logUrl } = deriveApiUrls(base);
  await fetch(logUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-access-token": token || "",
    },
    body: JSON.stringify(payload),
  });
}
