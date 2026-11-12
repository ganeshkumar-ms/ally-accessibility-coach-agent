import { useEffect, useState } from 'react'
import { fetchDocumentPreview } from '../services/api'

export default function DocumentViewer({ doc, onClose }) {
  const [loadedHtml, setLoadedHtml] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    setError('')
    setLoadedHtml('')

    if (!doc || doc.viewerHtml || doc.blobUrl) return

    if (doc.s3Key) {
      setLoading(true)
      fetchDocumentPreview(doc.s3Key, doc.name)
        .then(res => {
          if (active) setLoadedHtml(res.viewer_html || '')
        })
        .catch(err => {
          if (active) setError(err.message || 'Unable to load preview')
        })
        .finally(() => {
          if (active) setLoading(false)
        })
    }

    return () => { active = false }
  }, [doc])

  if (!doc) return null

  const htmlSource = doc.viewerHtml || loadedHtml
  const useIframeBlob = doc.blobUrl && /\.(pdf|txt|csv|json|xml|md)$/i.test(doc.name || '')

  return (
    <aside className="docViewer" aria-label="Source Document Viewer">
      <div className="docHead">
        <div className="docMeta">
          <span className="docBadge">ALLY SOURCE</span>
          <strong className="docName" title={doc.name}>{doc.name}</strong>
        </div>
        <button
          type="button"
          className="docClose"
          onClick={onClose}
          aria-label="Close document viewer"
        >
          Close
        </button>
      </div>

      <div className="docBody">
        {loading && <div className="docState">Loading preview...</div>}
        {error && <div className="docState err">{error}</div>}

        {!loading && !error && htmlSource ? (
          <iframe
            title={`Preview ${doc.name}`}
            srcDoc={htmlSource}
            className="docFrame"
            sandbox="allow-same-origin"
          />
        ) : !loading && !error && useIframeBlob ? (
          <iframe
            title={`Preview ${doc.name}`}
            src={doc.blobUrl}
            className="docFrame"
          />
        ) : !loading && !error && doc.extractedText ? (
          <pre className="docPre">{doc.extractedText}</pre>
        ) : !loading && !error ? (
          <div className="docState">
            Preview ready after analysis, or open a PDF, HTML, code, or text file.
          </div>
        ) : null}
      </div>
    </aside>
  )
}

