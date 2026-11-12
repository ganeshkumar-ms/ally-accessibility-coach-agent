const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/+$/, '')

function urlFor(path) {
  return API_BASE ? `${API_BASE}${path}` : path
}

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result || '')
      resolve(result.includes(',') ? result.split(',', 2)[1] : result)
    }
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`))
    reader.readAsDataURL(file)
  })
}

export async function prepareFilePayload(file) {
  if (!file) return {}
  const inlineLimit = 2.2 * 1024 * 1024
  if (file.size <= inlineLimit) {
    return {
      file_name: file.name,
      file_content_base64: await fileToBase64(file),
    }
  }
  const presignRes = await fetch(urlFor('/api/get-upload-url'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      file_name: file.name,
      content_type: file.type || 'application/octet-stream',
    }),
  })
  if (!presignRes.ok) {
    throw new Error(`Upload URL error (${presignRes.status})`)
  }
  const { upload_url, s3_key } = await presignRes.json()
  const putRes = await fetch(upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  })
  if (!putRes.ok) {
    throw new Error(`S3 upload failed (${putRes.status})`)
  }
  return {
    file_name: file.name,
    s3_key,
  }
}

export async function sendAllyReview({ message, history, filePayload }) {
  const res = await fetch(urlFor('/api/review'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: message || '',
      history: history || [],
      ...(filePayload || {}),
    }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(detail || `Server responded ${res.status}`)
  }
  return res.json()
}

export async function fetchDocumentPreview(s3Key, fileName) {
  const params = new URLSearchParams({
    s3_key: s3Key,
    file_name: fileName || '',
  })
  const res = await fetch(urlFor(`/api/view-document?${params.toString()}`))
  if (!res.ok) {
    throw new Error(`Unable to load preview (${res.status})`)
  }
  return res.json()
}

