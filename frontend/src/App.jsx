import React, { Component, useState, useEffect, useRef, useMemo } from 'react'
import AllySidebar from './components/AllySidebar'
import AllyResultCard from './components/AllyResultCard'
import DocumentViewer from './components/DocumentViewer'
import {
  prepareFilePayload,
  fileToBase64,
  sendAllyReview,
  scanPath,
  fetchDocumentPreview,
} from './services/api'
import './App.css'

const STORAGE_KEY = 'ally_accessibility_coach_sessions_v1'

function formatSize(bytes) {
  if (!bytes && bytes !== 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatSmartWords(rawStr) {
  const words = String(rawStr || '')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map(w => (['ui', 'ux', 'wcag', 'html', 'css', 'api', 'cms', 'dom', 'aria'].includes(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
  return words.slice(0, 5).join(' ')
}

function deriveTitle(text, doc, aiRes) {
  if (aiRes?.review_title) {
    const rawRev = String(aiRes.review_title).trim()
    if (!/\.(?:html?|jsx|tsx|css|js|md|pdf|docx)\b/i.test(rawRev) && !/highlighted_/i.test(rawRev)) {
      return rawRev.length > 42 ? `${rawRev.slice(0, 40).trim()}…` : rawRev
    }
    const cleanedRev = rawRev
      .replace(/\s*Web Accessibility Audit$/i, '')
      .replace(/\s*Accessibility Audit$/i, '')
      .replace(/\.[^.]+$/, '')
      .replace(/^(?:highlighted_|remediated_|wcag_|final_|fixed_)+/i, '')
    const smartRev = formatSmartWords(cleanedRev)
    if (smartRev) return `${smartRev} Accessibility Audit`
  }

  if (doc?.name) {
    const base = String(doc.name)
      .replace(/\.[^.]+$/, '')
      .replace(/^(?:highlighted_|remediated_|wcag_|final_|fixed_)+/i, '')
      .trim()
    const smartDoc = formatSmartWords(base)
    return smartDoc ? `${smartDoc} Audit` : 'Accessibility Review'
  }

  const rawText = String(text || '').trim()
  if (!rawText) return 'New conversation'

  const urlMatch = rawText.match(/(?:https?:\/\/|www\.)([^\s/]+)/i)
  if (urlMatch) {
    const host = urlMatch[1].replace(/^www\./i, '').split('.')[0]
    const hostTitle = host.charAt(0).toUpperCase() + host.slice(1)
    return `${hostTitle} Web Audit`
  }

  if (/^<[a-zA-Z]/.test(rawText)) {
    const tagMatch = rawText.match(/^<([a-zA-Z0-9-]+)/)
    const tagName = tagMatch ? tagMatch[1].toUpperCase() : 'DOM'
    return `${tagName} Markup Accessibility Audit`
  }

  const clean = rawText
    .replace(/^(?:please\s+|can\s+you\s+|check\s+|review\s+|audit\s+|inspect\s+|analyze\s+)/i, '')
    .trim()
  if (!clean || /^(?:hi+|hello+|hey+|thanks?|ok(?:ay)?)$/i.test(clean)) return 'New conversation'
  const firstLine = clean.split('\n')[0].slice(0, 36).trim()
  const titled = firstLine.charAt(0).toUpperCase() + firstLine.slice(1)
  return firstLine.length < clean.length ? `${titled}…` : titled
}

function getSmartPreview(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return 'No messages yet'
  const lastAi = [...messages].reverse().find(m => m.role === 'assistant')
  if (lastAi) {
    if (lastAi.structured?.coach_summary) return lastAi.structured.coach_summary
    if (lastAi.content) return String(lastAi.content).slice(0, 140)
  }
  const firstUser = messages.find(m => m.role === 'user')
  if (firstUser?.content) return String(firstUser.content).slice(0, 140)
  return 'Accessibility review session'
}

function formatInlineBold(text) {
  const parts = String(text || '').split(/(\**[^*]+\**)/g)
  return parts.map((part, idx) =>
    part.startsWith('**') && part.endsWith('**') ? (
      <strong key={idx}>{part.slice(2, -2)}</strong>
    ) : (
      part
    )
  )
}

function loadSessions() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
    if (!Array.isArray(raw)) return []
    const clean = raw
      .filter(s => s && s.id && Array.isArray(s.messages) && s.messages.length > 0)
      .map(s => {
        if (!s.titleLocked) {
          const lastAudit = [...s.messages].reverse().find(m => m.structured?.review_title)
          const firstUser = s.messages.find(m => m.role === 'user')
          const better = deriveTitle(firstUser?.content, firstUser?.doc, lastAudit?.structured)
          if (better && better !== 'New conversation') {
            return { ...s, title: better }
          }
        }
        return s
      })
    // Strictly sort by updatedAt descending so newest is always 1st
    return clean.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  } catch {
    return []
  }
}

function persistSessions(list) {
  try {
    const clean = (list || [])
      .filter(s => Array.isArray(s.messages) && s.messages.length > 0)
      .map(s => ({
        ...s,
        messages: s.messages.map(m => ({
          ...m,
          doc: m.doc
            ? {
                name: m.doc.name,
                size: m.doc.size,
                s3Key: m.doc.s3Key,
                sourceUrl: m.doc.sourceUrl,
                viewerHtml: m.doc.viewerHtml ? String(m.doc.viewerHtml).slice(0, 24000) : undefined,
                extractedText: m.doc.extractedText ? String(m.doc.extractedText).slice(0, 12000) : undefined,
              }
            : undefined,
        })),
      }))
    localStorage.setItem(STORAGE_KEY, JSON.stringify(clean.slice(0, 30)))
  } catch {
    // ignore storage quota
  }
}

export default function App() {
  const [sessions, setSessions] = useState(() => loadSessions())
  const [currentId, setCurrentId] = useState(null)
  const [draftMessages, setDraftMessages] = useState([])
  const [draftTitle, setDraftTitle] = useState('New conversation')
  const [view, setView] = useState('home')
  const [homeInput, setHomeInput] = useState('')
  const [chatInput, setChatInput] = useState('')
  const [attachedFiles, setAttachedFiles] = useState([]) // Array of files
  const [isLoading, setIsLoading] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [viewerDoc, setViewerDoc] = useState(null)

  // Repo / Folder path scanner state
  const [showPathModal, setShowPathModal] = useState(false)
  const [scanPathInput, setScanPathInput] = useState('')
  const [isScanningPath, setIsScanningPath] = useState(false)
  const [scanPathError, setScanPathError] = useState('')

  const homeFileRef = useRef(null)
  const chatFileRef = useRef(null)
  const messagesRef = useRef(null)
  const lastAiRef = useRef(null)
  const chatInputRef = useRef(null)

  const currentSession = useMemo(
    () => sessions.find(s => s.id === currentId) || null,
    [sessions, currentId]
  )
  const activeMessages = currentSession ? currentSession.messages : draftMessages
  useEffect(() => {
    persistSessions(sessions)
  }, [sessions])

  useEffect(() => {
    if (view === 'chat' && lastAiRef.current) {
      lastAiRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
    } else if (view === 'chat' && messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight
    }
  }, [activeMessages.length, view, currentId])

  useEffect(() => {
    if (editingTitle && currentSession) {
      setTitleDraft(currentSession.title || '')
    }
  }, [editingTitle, currentSession])

  function goHome() {
    setDrawerOpen(false)
    setViewerDoc(null)
    setCurrentId(null)
    setDraftMessages([])
    setDraftTitle('New conversation')
    setAttachedFiles([])
    setView('home')
  }

  function openNewChat() {
    setCurrentId(null)
    setDraftMessages([])
    setDraftTitle('New conversation')
    setAttachedFiles([])
    setViewerDoc(null)
    setView('chat')
    setTimeout(() => chatInputRef.current?.focus(), 80)
  }

  function loadSession(session) {
    setCurrentId(session.id)
    setAttachedFiles([])
    setViewerDoc(null)
    setView('chat')
    setDrawerOpen(false)
  }

  function commitTitle() {
    const trimmed = titleDraft.trim()
    setEditingTitle(false)
    if (!trimmed) return
    if (currentId) {
      setSessions(prev => {
        const target = prev.find(s => s.id === currentId)
        if (!target) return prev
        const updated = { ...target, title: trimmed, titleLocked: true }
        return [updated, ...prev.filter(s => s.id !== currentId)]
      })
    } else {
      setDraftTitle(trimmed)
    }
  }

  function renameSession(id, newTitle) {
    setSessions(prev => {
      const target = prev.find(s => s.id === id)
      if (!target) return prev
      const updated = { ...target, title: newTitle, titleLocked: true }
      return [updated, ...prev.filter(s => s.id !== id)]
    })
  }

  function deleteSession(id) {
    const idx = sessions.findIndex(s => s.id === id)
    const remaining = sessions.filter(s => s.id !== id)
    setSessions(remaining)
    if (currentId === id) {
      if (remaining.length > 0) {
        const nextSess = remaining[idx >= 0 && idx < remaining.length ? idx : remaining.length - 1]
        loadSession(nextSess)
      } else {
        openNewChat()
      }
    }
  }

  function handleFileSelect(fileList) {
    if (!fileList || fileList.length === 0) return
    const incoming = Array.from(fileList)
    setAttachedFiles(prev => {
      const existingNames = new Set(prev.map(f => f.name))
      const fresh = incoming.filter(f => !existingNames.has(f.name))
      return [...prev, ...fresh].slice(0, 20)
    })
  }

  function removeAttachedFile(idx) {
    setAttachedFiles(prev => prev.filter((_, i) => i !== idx))
  }

  async function handleScanPathSubmit(e) {
    if (e) e.preventDefault()
    const pathStr = scanPathInput.trim()
    if (!pathStr) return
    setIsScanningPath(true)
    setScanPathError('')
    try {
      const res = await scanPath(pathStr)
      if (res.files && res.files.length > 0) {
        setShowPathModal(false)
        setScanPathInput('')
        // Convert scanned files to simulated File objects or directly invoke handleSend with documents
        const docsPayload = res.files.map(f => ({
          name: f.name,
          extracted_text: f.extracted_text,
        }))
        await handleSend(
          `Accessibility scan of repository location: ${res.folder_path} (${res.total_files} files scanned)`,
          null,
          docsPayload
        )
      } else {
        setScanPathError(`No supported code/document files (.html, .jsx, .tsx, .css, .md, .pdf) found in: ${pathStr}`)
      }
    } catch (err) {
      setScanPathError(err.message || 'Failed to scan repository path.')
    } finally {
      setIsScanningPath(false)
    }
  }

  async function handleSend(rawText, filesOverride, docsOverride) {
    const text = String(rawText || '').trim()
    const files = filesOverride !== undefined ? filesOverride : attachedFiles
    const hasFiles = Array.isArray(files) && files.length > 0
    const hasDocs = Array.isArray(docsOverride) && docsOverride.length > 0

    if (!text && !hasFiles && !hasDocs) return
    if (isLoading) return

    setHomeInput('')
    setChatInput('')
    setAttachedFiles([])
    setView('chat')
    setIsLoading(true)

    // HOME SESSION ISOLATION:
    // If starting from home view or when no session is selected, ALWAYS generate fresh session!
    const isHomeStart = view === 'home' || !currentId
    const sessionId = (!isHomeStart && currentId) ? currentId : `ally_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    if (isHomeStart) {
      setCurrentId(sessionId)
    }

    const localDocMeta = hasFiles
      ? {
          name: files.length === 1 ? files[0].name : `${files.length} Files Selected`,
          size: files.length === 1 ? formatSize(files[0].size) : `${files.length} items`,
          blobUrl: files[0] ? URL.createObjectURL(files[0]) : null,
        }
      : hasDocs
      ? {
          name: docsOverride.length === 1 ? docsOverride[0].name : `${docsOverride.length} Scanned Files`,
          size: `${docsOverride.length} files`,
        }
      : null

    const userMsg = {
      id: `u_${Date.now()}`,
      role: 'user',
      content: text,
      doc: localDocMeta,
    }

    const baseMessages = (!isHomeStart && currentSession) ? currentSession.messages : []
    const nextMessages = [...baseMessages, userMsg]
    const initialTitle = (!isHomeStart && currentSession?.titleLocked)
      ? currentSession.title
      : baseMessages.length === 0
      ? deriveTitle(text, localDocMeta)
      : currentSession?.title || draftTitle

    // Immediately place session at index 0 (top of recent list)
    setSessions(prev => {
      const existing = prev.find(s => s.id === sessionId)
      const updated = existing
        ? { ...existing, title: initialTitle, updatedAt: Date.now(), messages: nextMessages }
        : {
            id: sessionId,
            title: initialTitle,
            titleLocked: false,
            updatedAt: Date.now(),
            messages: nextMessages,
          }
      return [updated, ...prev.filter(s => s.id !== sessionId)]
    })

    try {
      let filePayload = {}
      let documentsPayload = hasDocs ? docsOverride : []

      if (hasFiles) {
        if (files.length === 1) {
          filePayload = await prepareFilePayload(files[0])
        } else {
          documentsPayload = await Promise.all(
            files.map(async f => ({
              name: f.name,
              content_base64: await fileToBase64(f),
            }))
          )
        }
      }

      const historyPayload = baseMessages.slice(-8).map(m => ({
        role: m.role,
        content:
          m.role === 'assistant'
            ? (m.structured
                ? JSON.stringify({
                    title: m.structured.review_title,
                    scope: m.structured.content_scope,
                    verdict: m.structured.coach_verdict,
                    readiness_score: m.structured.readiness_score,
                    summary: m.structured.coach_summary,
                    findings: (m.structured.findings || []).slice(0, 12).map(f => ({
                      severity: f.priority || f.severity,
                      area: f.area || f.category,
                      issue: f.issue,
                      fix: f.how_to_improve || f.recommendation,
                    })),
                  }).slice(0, 2400)
                : m.content || '')
            : m.doc?.name
              ? `${m.content ? m.content + '\n' : ''}[Uploaded Content: ${m.doc.name}]`
              : m.content || '',
      }))

      const isRetryOrRefine = !hasFiles && !hasDocs && /\b(retry|try again|re-?analyze|redo|more specific|be more specific|more detail|deeper)\b/i.test(text)
      const priorUrlMatch = isRetryOrRefine
        ? [...baseMessages].reverse().find(m => m.role === 'user' && /https?:\/\/\S+/i.test(m.content || ''))?.content?.match(/https?:\/\/\S+/i)?.[0]
        : null
      const effectiveMessage = priorUrlMatch && !/https?:\/\/\S+/i.test(text)
        ? `${text}\n\nRe-analyze target URL with deeper, more specific findings: ${priorUrlMatch}`
        : text

      const [res] = await Promise.all([
        sendAllyReview({
          message: effectiveMessage,
          history: historyPayload,
          filePayload,
          documents: documentsPayload,
        }),
        new Promise(res => setTimeout(res, 800))
      ])

      const enrichedDoc = localDocMeta
        ? {
            ...localDocMeta,
            viewerHtml: res.viewer_html,
            extractedText: res.extracted_text,
            s3Key: filePayload.s3_key,
          }
        : res.viewer_html || res.source_url
          ? {
              name: res.file_name || res.source_url || 'webpage.html',
              size: 'Live URL',
              sourceUrl: res.source_url,
              viewerHtml: res.viewer_html,
              extractedText: res.extracted_text,
            }
          : null

      const aiMsg = {
        id: `a_${Date.now()}`,
        role: 'assistant',
        content: res.type === 'chat' ? res.message : res.coach_summary || res.review_title || 'Accessibility review complete',
        structured: (res.type === 'accessibility_review' || res.rejected || res.rejection_details) ? res : null,
      }

      // Update session and move to position 0 (1st in recent list)
      setSessions(prev => {
        const target = prev.find(s => s.id === sessionId)
        if (!target) return prev
        const updatedMsgs = target.messages.map(m =>
          m.id === userMsg.id && enrichedDoc ? { ...m, doc: enrichedDoc } : m
        )
        const finalMsgs = [...updatedMsgs, aiMsg]
        const postTitle = target.titleLocked
          ? target.title
          : deriveTitle(text, enrichedDoc, res) || target.title
        const updated = {
          ...target,
          title: postTitle,
          updatedAt: Date.now(),
          messages: finalMsgs,
        }
        return [updated, ...prev.filter(s => s.id !== sessionId)]
      })
    } catch (err) {
      const errMsg = {
        id: `a_${Date.now()}`,
        role: 'assistant',
        content: `Unable to complete accessibility review right now: ${err.message || 'Network error'}`,
      }
      setSessions(prev => {
        const target = prev.find(s => s.id === sessionId)
        if (!target) return prev
        const updated = {
          ...target,
          updatedAt: Date.now(),
          messages: [...target.messages, errMsg],
        }
        return [updated, ...prev.filter(s => s.id !== sessionId)]
      })
    } finally {
      setIsLoading(false)
    }
  }

  const lastAiIndex = (() => {
    for (let i = activeMessages.length - 1; i >= 0; i--) {
      if (activeMessages[i].role === 'assistant') return i
    }
    return -1
  })()

  return (
    <ErrorBoundary>
      <div className="app">
        <div className="aurora" />
        <div className="grid" />

        {view === 'home' ? (
          <section id="home" className="homePage">
            <header>
              <div className="word" onClick={goHome} style={{ cursor: 'pointer' }}>ALLY</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <button className="enter" type="button" onClick={openNewChat}>
                  ENTER WORKSPACE ↗
                </button>
              </div>
            </header>

            <main className="home">
              <div className="eyebrow">WEB ACCESSIBILITY COACH</div>
              <h1>
                Open access.<br />
                <span>Better experience.</span>
              </h1>
              <p className="sub">
                Audit web links, forms, headings, ARIA attributes, and color contrast. Submit live URLs, drop bulk code files, or scan local repos for enterprise WCAG 2.2 Level AA/AAA compliance.
              </p>

              <div className="promptGlow">
                <form
                  className="prompt"
                  onSubmit={e => {
                    e.preventDefault()
                    handleSend(homeInput, attachedFiles)
                  }}
                >
                  <input
                    ref={homeFileRef}
                    className="fileInput"
                    type="file"
                    multiple
                    accept=".html,.htm,.jsx,.tsx,.css,.md,.txt,.pdf,.docx,.csv,.json,.xml"
                    onChange={e => {
                      handleFileSelect(e.target.files)
                      e.target.value = ''
                    }}
                  />
                  <button
                    className="startAttach"
                    type="button"
                    aria-label="Attach page or UI files"
                    title="Attach HTML, JSX, CSS, MD, or document files"
                    onClick={() => homeFileRef.current?.click()}
                  >
                    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
                      <path d="m21.4 11.6-8.9 8.9a6 6 0 0 1-8.5-8.5l9.3-9.3a4 4 0 0 1 5.7 5.7l-9.3 9.3a2 2 0 0 1-2.8-2.8l8.6-8.6" />
                    </svg>
                  </button>
                  <button
                    className="startAttach"
                    type="button"
                    aria-label="Scan folder or repository"
                    title="Scan a local folder or repository path"
                    onClick={() => setShowPathModal(true)}
                  >
                    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    </svg>
                  </button>
                  <input
                    value={homeInput}
                    onChange={e => setHomeInput(e.target.value)}
                    placeholder="Ask ALLY, paste a URL (https://...), or paste UI / HTML markup..."
                    aria-label="Start conversation"
                  />
                  <button className="send" type="submit" aria-label="Send">
                    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M5 12h13" />
                      <path d="m13 7 5 5-5 5" />
                    </svg>
                  </button>
                </form>
              </div>

              {attachedFiles.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '8px', maxWidth: '720px', margin: '14px auto 0' }}>
                  {attachedFiles.map((f, idx) => (
                    <span key={idx} className="attachChip">
                      <span className="attachName">{f.name}</span>
                      <span className="attachSize">{formatSize(f.size)}</span>
                      <button
                        type="button"
                        className="attachRemove"
                        aria-label={`Remove ${f.name}`}
                        onClick={() => removeAttachedFile(idx)}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <div className="recentHead">
                <span>RECENT CONVERSATIONS</span>
              </div>

              <div className="cards">
                {sessions.length === 0 ? (
                  <div className="card emptyCard">
                    <small>NOTHING YET</small>
                    <b>No conversations yet</b>
                    <p>
                      Paste a webpage URL, HTML markup, copy, or attach a file above to get encouraging, actionable accessibility coaching.
                    </p>
                  </div>
                ) : (
                  sessions.slice(0, 3).map(sess => (
                    <button
                      key={sess.id}
                      type="button"
                      className="card"
                      onClick={() => loadSession(sess)}
                    >
                      <small>{new Date(sess.updatedAt || Date.now()).toLocaleDateString()}</small>
                      <b>{sess.title || 'Accessibility review'}</b>
                      <p>{getSmartPreview(sess.messages)}</p>
                    </button>
                  ))
                )}
              </div>
            </main>
          </section>
        ) : (
          <section className="chatPage" id="chatPage">
            <div className={`layout${viewerDoc ? ' withViewer' : ''}`}>
              <AllySidebar
                sessions={sessions}
                currentSessionId={currentId}
                isOpen={drawerOpen}
                onClose={() => setDrawerOpen(false)}
                onNew={openNewChat}
                onLoad={loadSession}
                onRename={renameSession}
                onDelete={deleteSession}
              />

              <main className="chat">
                <div className="chatHead">
                  <div className="headLeft titleCol">
                    {editingTitle ? (
                      <input
                        className="titleInput"
                        value={titleDraft}
                        autoFocus
                        onChange={e => setTitleDraft(e.target.value)}
                        onBlur={commitTitle}
                        onKeyDown={e => {
                          if (e.key === 'Enter') commitTitle()
                          if (e.key === 'Escape') setEditingTitle(false)
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        id="title"
                        className="titleEditable"
                        title="Click to rename conversation"
                        onClick={() => {
                          setTitleDraft(currentSession ? currentSession.title : draftTitle)
                          setEditingTitle(true)
                        }}
                      >
                        <span className="titleText">
                          {currentSession ? currentSession.title : draftTitle}
                        </span>
                      </button>
                    )}
                  </div>

                  <div className="mobileActions">
                    <button
                      className="mobileMenu"
                      type="button"
                      aria-label="Open recent conversations"
                      aria-expanded={drawerOpen}
                      onClick={() => setDrawerOpen(o => !o)}
                    >
                      <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M5 7h14M5 12h14M5 17h14" />
                      </svg>
                      <span className="recentTxt">RECENT</span>
                    </button>
                    <button
                      className="ghost"
                      type="button"
                      onClick={goHome}
                      title="Return to Home"
                    >
                      <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="m3 10 9-7 9 7" />
                        <path d="M5 9v11h14V9" />
                        <path d="M9 20v-6h6v6" />
                      </svg>
                      <span style={{ marginLeft: '7px' }}>HOME</span>
                    </button>
                  </div>
                </div>

                <div className="messages" ref={messagesRef} aria-live="polite">
                  {activeMessages.length === 0 && !isLoading && (
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', color: '#849bb4', maxWidth: '520px', margin: '0 auto', padding: '24px' }}>
                      <div style={{ display: 'inline-flex', padding: '13px', borderRadius: '14px', background: 'rgba(7, 140, 255, 0.1)', border: '1px solid rgba(7, 140, 255, 0.25)', color: '#38bdf8', marginBottom: '14px' }}>
                        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="12" cy="5" r="2" />
                          <path d="M5 9h14" />
                          <path d="M12 9v5l-3 6" />
                          <path d="m12 14 3 6" />
                        </svg>
                      </div>
                      <b style={{ display: 'block', color: '#fff', fontSize: '18px' }}>Start a new WCAG 2.2 coaching session with ALLY</b>
                      <p style={{ fontSize: '14.5px', lineHeight: '1.65', marginTop: '10px', marginBottom: 0 }}>
                        Share a webpage URL, paste HTML/JSX/CSS markup, or attach UI files below to uncover WCAG 2.2 Level A/AA barriers and generate compliant code fixes.
                      </p>
                    </div>
                  )}

                  {activeMessages.map((msg, idx) => {
                    const isLastAi = msg.role === 'assistant' && idx === lastAiIndex
                    return (
                      <div
                        key={msg.id || idx}
                        ref={isLastAi ? lastAiRef : null}
                        className={`bubble ${msg.role === 'user' ? 'user' : 'ai'}`}
                      >
                        {msg.role === 'user' && msg.doc?.name && (
                          <div className="userDocs">
                            <div className="docPill">
                              <span className="docPillName">{msg.doc.name}</span>
                              {msg.doc.size && <span className="docPillSize">{msg.doc.size}</span>}
                              {(msg.doc.viewerHtml || msg.doc.extractedText || msg.doc.blobUrl || msg.doc.s3Key) && (
                                <button
                                  type="button"
                                  className="docOpenBtn"
                                  onClick={() => setViewerDoc(msg.doc)}
                                >
                                  Open ↗
                                </button>
                              )}
                              {msg.doc.sourceUrl && (
                                <a
                                  href={msg.doc.sourceUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="docOpenBtn"
                                  style={{ textDecoration: 'none' }}
                                >
                                  Link ↗
                                </a>
                              )}
                            </div>
                          </div>
                        )}

                        {msg.role === 'user' ? (
                          msg.content && <div className="userText">{msg.content}</div>
                        ) : msg.structured ? (
                          <AllyResultCard
                            data={msg.structured}
                            guardrails={msg.structured?.guardrails || msg.guardrails}
                            onSendPrompt={prompt => handleSend(prompt)}
                          />
                        ) : (
                          <div className="chatProse">
                            {String(msg.content || '')
                              .split('\n\n')
                              .filter(Boolean)
                              .map((para, pIdx) => (
                                <p key={pIdx}>{formatInlineBold(para)}</p>
                              ))}
                          </div>
                        )}
                      </div>
                    )
                  })}

                  {isLoading && (
                    <div className="thinking">
                      <span className="thinkName">ALLY</span>
                      <span className="bars">
                        <i /><i /><i /><i />
                      </span>
                    </div>
                  )}
                </div>

                <div className="composerArea">
                  {attachedFiles.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '6px', maxWidth: '780px', margin: '0 auto 10px' }}>
                      {attachedFiles.map((f, idx) => (
                        <span key={idx} className="attachChip">
                          <span className="attachName">{f.name}</span>
                          <button
                            type="button"
                            className="attachRemove"
                            aria-label={`Remove ${f.name}`}
                            onClick={() => removeAttachedFile(idx)}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="composer">
                    <form
                      onSubmit={e => {
                        e.preventDefault()
                        handleSend(chatInput, attachedFiles)
                      }}
                    >
                      <input
                        ref={chatFileRef}
                        className="fileInput"
                        type="file"
                        multiple
                        accept=".html,.htm,.jsx,.tsx,.css,.md,.txt,.pdf,.docx,.csv,.json,.xml"
                        onChange={e => {
                          handleFileSelect(e.target.files)
                          e.target.value = ''
                        }}
                      />
                      <button
                        className="plus"
                        type="button"
                        aria-label="Attach page or UI files"
                        title="Attach HTML, JSX, CSS, MD, or document files"
                        onClick={() => chatFileRef.current?.click()}
                      >
                        <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
                          <path d="m21.4 11.6-8.9 8.9a6 6 0 0 1-8.5-8.5l9.3-9.3a4 4 0 0 1 5.7 5.7l-9.3 9.3a2 2 0 0 1-2.8-2.8l8.6-8.6" />
                        </svg>
                      </button>
                      <button
                        className="plus scanBtn"
                        type="button"
                        aria-label="Scan folder or repository"
                        title="Scan a local folder or repository path"
                        onClick={() => setShowPathModal(true)}
                      >
                        <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                        </svg>
                      </button>
                      <input
                        ref={chatInputRef}
                        value={chatInput}
                        onChange={e => setChatInput(e.target.value)}
                        placeholder="Message ALLY, paste a URL (https://...), or paste UI / HTML..."
                        maxLength={4000}
                        autoComplete="off"
                        aria-label="Message"
                      />
                      <button className="chatSend" type="submit" disabled={isLoading} aria-label="Send">
                        <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M5 12h13" />
                          <path d="m13 7 5 5-5 5" />
                        </svg>
                      </button>
                    </form>
                  </div>

                  <div className="fine">ALLY · WEB ACCESSIBILITY COACH · BEDROCK AI</div>
                </div>
              </main>

              {viewerDoc && (
                <DocumentViewer
                  doc={viewerDoc}
                  onClose={() => setViewerDoc(null)}
                />
              )}
            </div>
          </section>
        )}

        {/* REPO / FOLDER PATH SCANNER MODAL */}
        {showPathModal && (
          <div className="modalBackdrop" onClick={() => setShowPathModal(false)}>
            <div className="modalCard" onClick={e => e.stopPropagation()}>
              <div className="modalHead">
                <h3>Scan Repository or Local Folder Path</h3>
                <button
                  type="button"
                  className="modalCloseBtn"
                  onClick={() => setShowPathModal(false)}
                >
                  ×
                </button>
              </div>
              <p className="modalSub">
                Enter an absolute or relative directory path to bulk-audit all HTML, JSX, TSX, CSS, MD, and PDF files for WCAG accessibility violations.
              </p>
              <form onSubmit={handleScanPathSubmit}>
                <input
                  type="text"
                  className="modalInput"
                  placeholder="e.g. C:\Projects\MyWebApp\src or /var/www/html"
                  value={scanPathInput}
                  onChange={e => setScanPathInput(e.target.value)}
                  autoFocus
                />
                {scanPathError && <div className="modalError">{scanPathError}</div>}
                <div className="modalActions">
                  <button
                    type="button"
                    className="modalCancelBtn"
                    onClick={() => setShowPathModal(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="modalScanBtn"
                    disabled={isScanningPath || !scanPathInput.trim()}
                  >
                    {isScanningPath ? 'Scanning Files...' : 'Scan Location'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </ErrorBoundary>
  )
}

class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }
  componentDidCatch(error, info) {
    console.error('ALLY caught an error:', error, info)
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 32, color: '#f87171', background: '#020c16', minHeight: '100vh', fontFamily: 'system-ui' }}>
          <h2>Something went wrong in ALLY</h2>
          <pre style={{ whiteSpace: 'pre-wrap', background: 'rgba(239, 68, 68, 0.1)', padding: 16, borderRadius: 8 }}>
            {String(this.state.error?.stack || this.state.error)}
          </pre>
          <button
            onClick={() => {
              localStorage.removeItem(STORAGE_KEY)
              window.location.reload()
            }}
            style={{ marginTop: 16, padding: '8px 16px', background: '#078cff', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}
          >
            Reset App State &amp; Reload
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
