import React, { Component, useEffect, useMemo, useRef, useState } from 'react'
import AllySidebar from './components/AllySidebar'
import AllyResultCard from './components/AllyResultCard'
import DocumentViewer from './components/DocumentViewer'
import { prepareFilePayload, sendAllyReview } from './services/api'

const STORAGE_KEY = 'ally_sessions_v1'
const GREETING_RE = /^\s*(?:hi+|hello+|helo+|hey+|hola+|namaste|ji+|yo+|sup|thanks?|thank\s+you|ok(?:ay)?|cool|nice|great)\s*[!?.👋🙏]*\s*$/i

class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false }
  }
  static getDerivedStateFromError() {
    return { hasError: true }
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="errScreen">
          <h2>ALLY recovered from an unexpected display error.</h2>
          <button type="button" onClick={() => window.location.reload()}>Reload ALLY</button>
        </div>
      )
    }
    return this.props.children
  }
}

function formatInlineBold(text) {
  const parts = String(text || '').split(/(\*\*[^*]+\*\*)/g)
  return parts.map((part, idx) =>
    part.startsWith('**') && part.endsWith('**') ? (
      <strong key={idx}>{part.slice(2, -2)}</strong>
    ) : (
      part
    )
  )
}

function cleanFileTitle(name) {
  return String(name || 'Document')
    .replace(/\.[^/.]+$/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function deriveTitle(rawPrompt, fileMeta) {
  if (fileMeta?.name) {
    return `${cleanFileTitle(fileMeta.name)} Accessibility`.slice(0, 56)
  }
  const t = String(rawPrompt || '').trim()
  if (!t || GREETING_RE.test(t)) return 'New conversation'
  const stripped = t
    .replace(/^(?:can\s+you\s+please|could\s+you\s+please|please\s+can\s+you|kindly|please|help\s+me|check|review|audit|improve)\s+/i, '')
    .trim()
  const urlMatch = (stripped || t).match(/https?:\/\/(?:www\.)?([^\s/]+)([^\s]*)/i)
  if (urlMatch && !t.includes('<')) {
    const host = urlMatch[1]
    return `${host} Accessibility`.slice(0, 56)
  }
  const chosen = stripped || t
  return chosen.length > 48 ? `${chosen.slice(0, 45).trim()}...` : chosen
}

function getSmartPreview(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return 'No messages yet'
  const lastAi = [...messages].reverse().find(m => m.role === 'assistant')
  if (lastAi?.structured) {
    return (
      lastAi.structured.coach_summary ||
      lastAi.structured.review_title ||
      lastAi.structured.findings?.[0]?.issue ||
      'Accessibility review complete'
    )
  }
  if (lastAi?.content && !GREETING_RE.test(lastAi.content)) {
    return lastAi.content.slice(0, 120)
  }
  const firstDoc = messages.find(m => m.doc?.name)
  if (firstDoc) return firstDoc.doc.name
  const nonGreeting = messages.find(m => m.role === 'user' && m.content && !GREETING_RE.test(m.content))
  return nonGreeting ? nonGreeting.content.slice(0, 120) : 'Accessibility coaching conversation'
}

function formatSize(bytes) {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function loadSessions() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
    if (!Array.isArray(raw)) return []
    return raw
      .filter(s => s && s.id && Array.isArray(s.messages) && s.messages.length > 0)
      .map(s => {
        if (!s.titleLocked) {
          const lastAudit = [...s.messages].reverse().find(m => m.structured?.review_title)
          if (lastAudit?.structured?.review_title) {
            return { ...s, title: lastAudit.structured.review_title }
          }
          const firstUser = s.messages.find(m => m.role === 'user')
          if (firstUser) {
            const better = deriveTitle(firstUser.content, firstUser.doc)
            if (better !== 'New conversation' && better !== s.title) {
              return { ...s, title: better }
            }
          }
        }
        return s
      })
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
  const [attachedFile, setAttachedFile] = useState(null)
  const [isLoading, setIsLoading] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [viewerDoc, setViewerDoc] = useState(null)

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
  const activeTitle = currentSession ? currentSession.title : draftTitle

  useEffect(() => {
    persistSessions(sessions)
  }, [sessions])

  useEffect(() => {
    if (view !== 'chat') return
    if (lastAiRef.current) {
      lastAiRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
    } else if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight
    }
  }, [activeMessages.length, view, currentId])

  useEffect(() => {
    const onEsc = e => {
      if (e.key === 'Escape') setDrawerOpen(false)
    }
    window.addEventListener('keydown', onEsc)
    return () => window.removeEventListener('keydown', onEsc)
  }, [])

  function openNewChat() {
    setCurrentId(null)
    setDraftMessages([])
    setDraftTitle('New conversation')
    setAttachedFile(null)
    setViewerDoc(null)
    setView('chat')
    setTimeout(() => chatInputRef.current?.focus(), 80)
  }

  function loadSession(session) {
    setCurrentId(session.id)
    setAttachedFile(null)
    setViewerDoc(null)
    setView('chat')
  }

  function commitInlineTitle() {
    const trimmed = titleDraft.trim()
    setEditingTitle(false)
    if (!trimmed) return
    if (currentId) {
      setSessions(prev =>
        prev.map(s => (s.id === currentId ? { ...s, title: trimmed, titleLocked: true } : s))
      )
    } else {
      setDraftTitle(trimmed)
    }
  }

  function renameSession(id, newTitle) {
    setSessions(prev =>
      prev.map(s => (s.id === id ? { ...s, title: newTitle, titleLocked: true } : s))
    )
  }

  function deleteSession(id) {
    setSessions(prev => prev.filter(s => s.id !== id))
    if (currentId === id) {
      setCurrentId(null)
      setDraftMessages([])
      setDraftTitle('New conversation')
      setViewerDoc(null)
      setView('home')
    }
  }

  async function handleSend(rawText, fileOverride) {
    const text = String(rawText || '').trim()
    const file = fileOverride !== undefined ? fileOverride : attachedFile
    if (!text && !file) return
    if (isLoading) return

    setHomeInput('')
    setChatInput('')
    setAttachedFile(null)
    setView('chat')
    setIsLoading(true)

    const sessionId = currentId || `ally_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    const localDocMeta = file
      ? {
          name: file.name,
          size: formatSize(file.size),
          blobUrl: URL.createObjectURL(file),
        }
      : null

    const userMsg = {
      id: `u_${Date.now()}`,
      role: 'user',
      content: text,
      doc: localDocMeta,
    }

    const baseMessages = currentSession ? currentSession.messages : draftMessages
    const nextMessages = [...baseMessages, userMsg]
    const initialTitle =
      currentSession?.titleLocked
        ? currentSession.title
        : baseMessages.length === 0
          ? deriveTitle(text, localDocMeta)
          : currentSession?.title || draftTitle

    if (!currentId) {
      setCurrentId(sessionId)
      setSessions(prev => [
        {
          id: sessionId,
          title: initialTitle,
          titleLocked: false,
          updatedAt: Date.now(),
          messages: nextMessages,
        },
        ...prev,
      ])
    } else {
      setSessions(prev =>
        prev.map(s =>
          s.id === sessionId
            ? { ...s, title: initialTitle, updatedAt: Date.now(), messages: nextMessages }
            : s
        )
      )
    }

    try {
      const filePayload = file ? await prepareFilePayload(file) : {}
      const historyPayload = baseMessages.slice(-8).map(m => ({
        role: m.role,
        content:
          m.role === 'assistant'
            ? m.structured?.coach_summary || m.structured?.review_title || m.content || ''
            : m.doc?.name
              ? `${m.content ? m.content + '\n' : ''}[Uploaded File: ${m.doc.name}]`
              : m.content || '',
      }))

      const res = await sendAllyReview({
        message: text,
        history: historyPayload,
        filePayload,
      })

      const enrichedDoc = localDocMeta
        ? {
            ...localDocMeta,
            viewerHtml: res.viewer_html,
            extractedText: res.extracted_text,
            s3Key: filePayload.s3_key,
          }
        : res.viewer_html
          ? {
              name: res.file_name || res.source_url || 'webpage.html',
              size: 'Live URL',
              viewerHtml: res.viewer_html,
              extractedText: res.extracted_text,
            }
          : null

      const aiMsg = {
        id: `a_${Date.now()}`,
        role: 'assistant',
        content: res.type === 'chat' ? res.message : res.coach_summary || res.review_title || 'Accessibility review complete',
        structured: res.type === 'accessibility_review' ? res : null,
      }

      setSessions(prev =>
        prev.map(s => {
          if (s.id !== sessionId) return s
          const updatedMsgs = s.messages.map(m =>
            m.id === userMsg.id && enrichedDoc ? { ...m, doc: enrichedDoc } : m
          )
          const finalMsgs = [...updatedMsgs, aiMsg]
          const postTitle = s.titleLocked
            ? s.title
            : res.review_title || (s.title === 'New conversation' ? deriveTitle(text, enrichedDoc) : s.title)
          return {
            ...s,
            title: postTitle,
            updatedAt: Date.now(),
            messages: finalMsgs,
          }
        })
      )
    } catch (err) {
      const errMsg = {
        id: `a_${Date.now()}`,
        role: 'assistant',
        content: `Unable to complete accessibility review right now: ${err.message || 'Network error'}`,
      }
      setSessions(prev =>
        prev.map(s =>
          s.id === sessionId
            ? { ...s, updatedAt: Date.now(), messages: [...s.messages, errMsg] }
            : s
        )
      )
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
              <div className="word">ALLY</div>
              <button className="enter" type="button" onClick={openNewChat}>
                ENTER WORKSPACE ↗
              </button>
            </header>

            <main className="home">
              <div className="eyebrow">WEB ACCESSIBILITY COACH</div>
              <h1>
                Open access.<br />
                <span>Better experience.</span>
              </h1>
              <p className="sub">
                Paste a website URL, UI markup, links, form labels, or error copy — or upload a page file — for practical Issue -&gt; Why it matters -&gt; How to improve coaching.
              </p>

              <div className="promptGlow">
                <form
                  className="prompt"
                  onSubmit={e => {
                    e.preventDefault()
                    handleSend(homeInput, attachedFile)
                  }}
                >
                  <input
                    ref={homeFileRef}
                    className="fileInput"
                    type="file"
                    accept=".html,.htm,.jsx,.tsx,.css,.md,.txt,.pdf,.docx,.csv,.json,.xml"
                    onChange={e => {
                      const f = e.target.files?.[0]
                      if (f) setAttachedFile(f)
                      e.target.value = ''
                    }}
                  />
                  <button
                    className="startAttach"
                    type="button"
                    aria-label="Attach page or UI file"
                    title="Attach HTML, JSX, MD, or document file"
                    onClick={() => homeFileRef.current?.click()}
                  >
                    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
                      <path d="m21.4 11.6-8.9 8.9a6 6 0 0 1-8.5-8.5l9.3-9.3a4 4 0 0 1 5.7 5.7l-9.3 9.3a2 2 0 0 1-2.8-2.8l8.6-8.6" />
                    </svg>
                  </button>
                  <input
                    value={homeInput}
                    onChange={e => setHomeInput(e.target.value)}
                    placeholder="Ask ALLY, paste a URL (https://...), or paste UI / HTML..."
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

              {attachedFile && (
                <div className="attachedRow">
                  <span className="attachChip">
                    <span className="attachName">{attachedFile.name}</span>
                    <button
                      type="button"
                      className="attachRemove"
                      aria-label={`Remove ${attachedFile.name}`}
                      onClick={() => setAttachedFile(null)}
                    >
                      ×
                    </button>
                  </span>
                </div>
              )}

              <div className="recentHead">
                <b>Continue where you left off</b>
                <span>RECENT CONVERSATIONS</span>
              </div>

              <div className="cards">
                {sessions.length === 0 ? (
                  <div className="emptyCard">
                    <div className="emptyTitle">No conversations yet</div>
                    <p className="emptyDesc">
                      Paste a webpage URL, HTML, copy, or attach a file above to get encouraging, actionable accessibility coaching.
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
          <section className={`chatPage${drawerOpen ? ' drawerOpen' : ''}`}>
            <div className={`scrim${drawerOpen ? ' show' : ''}`} onClick={() => setDrawerOpen(false)} />

            <div className={`layout${viewerDoc ? ' withViewer' : ''}`}>
              <AllySidebar
                sessions={sessions}
                currentSessionId={currentId}
                onNew={openNewChat}
                onLoad={loadSession}
                onClose={() => setDrawerOpen(false)}
                isOpen={drawerOpen}
                onRename={renameSession}
                onDelete={deleteSession}
              />

              <main className="chat">
                <div className="chatHead">
                  <div className="headLeft">
                    {editingTitle ? (
                      <input
                        autoFocus
                        className="titleInput"
                        value={titleDraft}
                        maxLength={60}
                        onChange={e => setTitleDraft(e.target.value)}
                        onBlur={commitInlineTitle}
                        onKeyDown={e => {
                          if (e.key === 'Enter') commitInlineTitle()
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
                          setTitleDraft(activeTitle)
                          setEditingTitle(true)
                        }}
                      >
                        {activeTitle}
                      </button>
                    )}
                    <small>WEB ACCESSIBILITY COACH · INCLUSIVE UX GUIDANCE</small>
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
                      onClick={() => {
                        setDrawerOpen(false)
                        setViewerDoc(null)
                        setView('home')
                      }}
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
                    <div className="welcomeHint">
                      <div className="welcomeTitle">Ready to Coach Accessibility</div>
                      <p>
                        Paste HTML markup, links (like <code>Click here</code>), form instructions, or attach a page file for practical improvements.
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
                              <button
                                type="button"
                                className="docOpenBtn"
                                onClick={() => setViewerDoc(msg.doc)}
                              >
                                Open ↗
                              </button>
                            </div>
                          </div>
                        )}

                        {msg.role === 'user' ? (
                          msg.content && <div className="userText">{msg.content}</div>
                        ) : msg.structured ? (
                          <AllyResultCard data={msg.structured} />
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
                  {attachedFile && (
                    <div className="attachedRow composerAttached">
                      <span className="attachChip">
                        <span className="attachName">{attachedFile.name}</span>
                        <button
                          type="button"
                          className="attachRemove"
                          aria-label={`Remove ${attachedFile.name}`}
                          onClick={() => setAttachedFile(null)}
                        >
                          ×
                        </button>
                      </span>
                    </div>
                  )}

                  <div className="composer">
                    <form
                      onSubmit={e => {
                        e.preventDefault()
                        handleSend(chatInput, attachedFile)
                      }}
                    >
                      <input
                        ref={chatFileRef}
                        className="fileInput"
                        type="file"
                        accept=".html,.htm,.jsx,.tsx,.css,.md,.txt,.pdf,.docx,.csv,.json,.xml"
                        onChange={e => {
                          const f = e.target.files?.[0]
                          if (f) setAttachedFile(f)
                          e.target.value = ''
                        }}
                      />
                      <button
                        className="plus"
                        type="button"
                        aria-label="Attach page or UI file"
                        title="Attach HTML, JSX, MD, or document file"
                        onClick={() => chatFileRef.current?.click()}
                      >
                        <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
                          <path d="m21.4 11.6-8.9 8.9a6 6 0 0 1-8.5-8.5l9.3-9.3a4 4 0 0 1 5.7 5.7l-9.3 9.3a2 2 0 0 1-2.8-2.8l8.6-8.6" />
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
      </div>
    </ErrorBoundary>
  )
}

