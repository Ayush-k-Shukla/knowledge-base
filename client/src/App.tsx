import axios from 'axios';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Bot,
  BrainCircuit,
  CheckCircle2,
  FileText,
  Globe,
  Link,
  Loader2,
  PlusCircle,
  Send,
  Trash2,
  UploadCloud,
  User,
  AlertCircle,
  AlertTriangle,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000';

interface Message {
  id: string;
  type: 'user' | 'bot';
  text: string;
  confidenceScore?: number;
  confidenceReasoning?: string;
}

interface UploadedFile {
  name: string;
  status: 'uploading' | 'indexed';
}

interface IndexedWebsite {
  url: string;
  title: string;
  pageCount: number;
  status: 'crawling' | 'indexed';
}

interface ChatSession {
  _id: string;
  title: string;
  createdAt?: string;
}

const TypingIndicator = () => (
  <div className='typing-dots'>
    {[0, 1, 2].map((i) => (
      <motion.div
        key={i}
        className='dot'
        animate={{
          opacity: [0.4, 1, 0.4],
          scale: [1, 1.2, 1],
        }}
        transition={{
          duration: 1.2,
          repeat: Infinity,
          delay: i * 0.2,
          ease: 'easeInOut',
        }}
      />
    ))}
  </div>
);

function AuthScreen({
  authMode,
  email,
  password,
  error,
  loading,
  onEmailChange,
  onPasswordChange,
  onModeChange,
  onSubmit,
}: {
  authMode: 'login' | 'register';
  email: string;
  password: string;
  error: string | null;
  loading: boolean;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onModeChange: (mode: 'login' | 'register') => void;
  onSubmit: () => void;
}) {
  return (
    <div className='auth-screen'>
      <div className='auth-card glass'>
        <div className='auth-heading'>
          <BrainCircuit size={32} className='text-indigo-400' />
          <div>
            <h1>Welcome to Nexus RAG</h1>
            <p>
              Sign in or register to keep your chat history private and scoped
              to your account.
            </p>
          </div>
        </div>

        <div className='auth-form'>
          <div className='auth-mode-toggle'>
            <button
              type='button'
              className={authMode === 'login' ? 'active' : ''}
              onClick={() => onModeChange('login')}
            >
              Login
            </button>
            <button
              type='button'
              className={authMode === 'register' ? 'active' : ''}
              onClick={() => onModeChange('register')}
            >
              Sign Up
            </button>
          </div>

          <label>Email</label>
          <input
            type='email'
            value={email}
            onChange={(e) => onEmailChange(e.target.value)}
            placeholder='you@example.com'
          />

          <label>Password</label>
          <input
            type='password'
            value={password}
            onChange={(e) => onPasswordChange(e.target.value)}
            placeholder='Enter your password'
          />

          {error && <div className='auth-error'>{error}</div>}

          <button
            type='button'
            className='auth-submit'
            onClick={onSubmit}
            disabled={loading}
          >
            {loading
              ? 'Processing...'
              : authMode === 'login'
                ? 'Login'
                : 'Create account'}
          </button>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: '1',
      type: 'bot',
      text: 'Hello! I am your AI Knowledge Assistant. Upload a PDF or text document, and I will help you answer questions about it.',
    },
  ]);
  const [input, setInput] = useState('');
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [isAsking, setIsAsking] = useState(false);
  const [websites, setWebsites] = useState<IndexedWebsite[]>([]);
  const [urlInput, setUrlInput] = useState('');
  const [isCrawling, setIsCrawling] = useState(false);
  const [chatSessions, setChatSessions] = useState<ChatSession[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(() =>
    localStorage.getItem('jwt_token'),
  );
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const isAuthenticated = useMemo(() => !!token, [token]);

  const defaultMessage = useMemo(
    () => ({
      id: '1',
      type: 'bot' as const,
      text: 'Hello! I am your AI Knowledge Assistant. Upload a PDF or text document, and I will help you answer questions about it.',
    }),
    [],
  );

  const resetChatState = useCallback(() => {
    setChatSessions([]);
    setActiveChatId(null);
    setFiles([]);
    setWebsites([]);
    setMessages([defaultMessage]);
  }, [defaultMessage]);

  const parseSources = (sourcesText: string) => {
    const lines = sourcesText.split(/\r?\n/);
    const rawSources: Array<{ sourceId: string; sentences: string[] }> = [];
    let currentSource: { sourceId: string; sentences: string[] } | null = null;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      let sourceMatch = line.match(/^\d+\.\s*\*\*(.+?)\*\*$/);
      if (!sourceMatch) {
        sourceMatch = line.match(/^\d+\.\s*\[(.+?)\]$/);
      }
      const sentenceMatch = line.match(/^[-*]\s+(.+)$/);

      if (sourceMatch) {
        if (currentSource) {
          rawSources.push(currentSource);
        }
        currentSource = {
          sourceId: sourceMatch[1],
          sentences: [],
        };
      } else if (sentenceMatch && currentSource) {
        currentSource.sentences.push(sentenceMatch[1]);
      } else if (currentSource) {
        currentSource.sentences.push(line);
      }
    }

    if (currentSource) {
      rawSources.push(currentSource);
    }

    return rawSources.map((source, index) => ({
      ...source,
      marker: `[${index + 1}]`,
      snippet: source.sentences[0] || 'Source snippet unavailable.',
    }));
  };

  const parseBotMessage = (text: string) => {
    const splitIndex = text.indexOf('\n### Sources\n');
    if (splitIndex === -1) {
      return {
        mainText: text,
        sources: [] as Array<{
          sourceId: string;
          sentences: string[];
          marker: string;
          snippet: string;
        }>,
      };
    }

    const mainText = text.slice(0, splitIndex).trim();
    const sourcesText = text.slice(splitIndex + '\n### Sources\n'.length);

    return {
      mainText: mainText || text,
      sources: parseSources(sourcesText),
    };
  };

  const logout = useCallback(() => {
    localStorage.removeItem('jwt_token');
    setToken(null);
    resetChatState();
  }, [resetChatState]);

  useEffect(() => {
    if (token) {
      localStorage.setItem('jwt_token', token);
    } else {
      localStorage.removeItem('jwt_token');
    }
  }, [token]);

  useEffect(() => {
    const requestInterceptor = axios.interceptors.request.use((config) => {
      if (token) {
        (config.headers as any).Authorization = `Bearer ${token}`;
      }
      return config;
    });

    const responseInterceptor = axios.interceptors.response.use(
      (response) => response,
      (error) => {
        if (error.response?.status === 401) {
          logout();
        }
        return Promise.reject(error);
      },
    );

    return () => {
      axios.interceptors.request.eject(requestInterceptor);
      axios.interceptors.response.eject(responseInterceptor);
    };
  }, [token, logout]);

  const handleAuthSubmit = async () => {
    if (!authEmail.trim() || !authPassword.trim()) {
      setAuthError('Email and password are required.');
      return;
    }

    setAuthLoading(true);
    setAuthError(null);

    try {
      const response = await axios.post(`${API_BASE}/auth/${authMode}`, {
        email: authEmail.trim(),
        password: authPassword,
      });
      setToken(response.data.access_token);
      setAuthEmail('');
      setAuthPassword('');
    } catch (error: any) {
      setAuthError(
        error.response?.data?.message ||
          error.message ||
          'Authentication failed. Please try again.',
      );
    } finally {
      setAuthLoading(false);
    }
  };

  const handleNewChat = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      const res = await axios.post(`${API_BASE}/chat/session`);
      setChatSessions((prev) => [res.data, ...prev]);
      setActiveChatId(res.data._id);
    } catch (e) {
      console.error('Failed to create session', e);
    }
  }, [isAuthenticated]);

  const fetchSessions = useCallback(async () => {
    if (!isAuthenticated) return;

    try {
      const res = await axios.get(`${API_BASE}/chat/sessions`);
      if (res.data && res.data.length > 0) {
        setChatSessions(res.data);
        if (!activeChatId) {
          setActiveChatId(res.data[0]._id);
        }
      } else {
        await handleNewChat();
      }
    } catch (error) {
      console.error('Failed to fetch sessions', error);
    }
  }, [activeChatId, handleNewChat, isAuthenticated]);

  useEffect(() => {
    if (isAuthenticated) {
      fetchSessions();
    } else {
      resetChatState();
    }
  }, [fetchSessions, isAuthenticated, resetChatState]);

  const handleDeleteChat = async (chatId: string) => {
    if (!chatId) return;
    try {
      await axios.delete(`${API_BASE}/chat/${chatId}`);
      const remaining = chatSessions.filter(
        (session) => session._id !== chatId,
      );
      setChatSessions(remaining);

      if (activeChatId === chatId) {
        if (remaining.length > 0) {
          setActiveChatId(remaining[0]._id);
        } else {
          await handleNewChat();
        }
      }
    } catch (error) {
      console.error('Delete chat failed', error);
      alert('Unable to delete chat. Please try again.');
    }
  };

  useEffect(() => {
    if (!activeChatId) return;

    const fetchData = async () => {
      setFiles([]);
      setWebsites([]);
      setMessages([
        {
          id: '1',
          type: 'bot',
          text: 'Hello! I am your AI Knowledge Assistant. Upload a PDF or text document, and I will help you answer questions about it.',
        },
      ]);

      try {
        const [docsRes, chatRes, websitesRes] = await Promise.all([
          axios.get(`${API_BASE}/document/${activeChatId}`),
          axios.get(`${API_BASE}/chat/history/${activeChatId}`),
          axios.get(`${API_BASE}/website/${activeChatId}`),
        ]);

        if (docsRes.data) {
          setFiles(
            docsRes.data.map((d: any) => ({
              name: d.filename,
              status: 'indexed',
            })),
          );
        }

        if (websitesRes.data) {
          setWebsites(
            websitesRes.data.map((w: any) => ({
              url: w.url,
              title: w.title || w.url,
              pageCount: w.pageCount,
              status: 'indexed',
            })),
          );
        }

        if (chatRes.data && chatRes.data.length > 0) {
          setMessages(
            chatRes.data.map((m: any) => ({
              id: m._id,
              type: m.role,
              text: m.content,
              confidenceScore: m.confidenceScore,
              confidenceReasoning: m.confidenceReasoning,
            })),
          );
        }
      } catch (error) {
        console.error('Failed to fetch data', error);
      }
    };
    fetchData();
  }, [activeChatId]);

  useEffect(scrollToBottom, [messages]);

  const onDrop = useCallback(
    async (acceptedFiles: File[]) => {
      if (!activeChatId) return;
      const file = acceptedFiles[0];
      if (!file) return;

      setIsUploading(true);
      setFiles((prev) => [...prev, { name: file.name, status: 'uploading' }]);

      const formData = new FormData();
      formData.append('file', file);

      try {
        await axios.post(
          `${API_BASE}/document/upload/${activeChatId}`,
          formData,
          {
            headers: { 'Content-Type': 'multipart/form-data' },
          },
        );
        setFiles((prev) =>
          prev.map((f) =>
            f.name === file.name ? { ...f, status: 'indexed' } : f,
          ),
        );
      } catch (error) {
        console.error('Upload failed', error);
        alert(
          'Failed to upload document. Make sure the backend is running and Pinecone is configured correctly.',
        );
        setFiles((prev) => prev.filter((f) => f.name !== file.name));
      } finally {
        setIsUploading(false);
      }
    },
    [activeChatId],
  );

  const handleAddUrl = async () => {
    if (!activeChatId) return;
    const trimmed = urlInput.trim();
    if (!trimmed || isCrawling) return;

    try {
      new URL(trimmed); // validate format client-side
    } catch {
      alert('Please enter a valid URL (include https://)');
      return;
    }

    setIsCrawling(true);
    setWebsites((prev) => [
      { url: trimmed, title: trimmed, pageCount: 0, status: 'crawling' },
      ...prev.filter((w) => w.url !== trimmed),
    ]);
    setUrlInput('');

    try {
      const res = await axios.post(
        `${API_BASE}/website/index/${activeChatId}`,
        { url: trimmed, depth: 1 },
      );
      setWebsites((prev) =>
        prev.map((w) =>
          w.url === trimmed
            ? {
                url: trimmed,
                title: res.data.title,
                pageCount: res.data.pageCount,
                status: 'indexed',
              }
            : w,
        ),
      );
    } catch (error) {
      console.error('Website indexing failed', error);
      alert('Failed to index website. Check the URL and server logs.');
      setWebsites((prev) => prev.filter((w) => w.url !== trimmed));
    } finally {
      setIsCrawling(false);
    }
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'application/pdf': ['.pdf'], 'text/plain': ['.txt'] },
    multiple: false,
  });

  const handleSend = async () => {
    if (!input.trim() || isAsking || !activeChatId) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      type: 'user',
      text: input,
    };
    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setIsAsking(true);

    try {
      const response = await axios.post(
        `${API_BASE}/chat/ask/${activeChatId}`,
        { question: input },
      );
      const botMessage: Message = {
        id: (Date.now() + 1).toString(),
        type: 'bot',
        text: response.data.answer,
        confidenceScore: response.data.confidenceScore,
        confidenceReasoning: response.data.confidenceReasoning,
      };
      setMessages((prev) => [...prev, botMessage]);
    } catch (error) {
      console.error('Ask failed', error);
      const errorMessage: Message = {
        id: (Date.now() + 1).toString(),
        type: 'bot',
        text: 'Sorry, I encountered an error while processing your request.',
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setIsAsking(false);
      // Refresh sessions to update chat titles
      await fetchSessions();
    }
  };

  if (!isAuthenticated) {
    return (
      <AuthScreen
        authMode={authMode}
        email={authEmail}
        password={authPassword}
        error={authError}
        loading={authLoading}
        onEmailChange={setAuthEmail}
        onPasswordChange={setAuthPassword}
        onModeChange={setAuthMode}
        onSubmit={handleAuthSubmit}
      />
    );
  }

  return (
    <div className='app-container'>
      {/* Sidebar */}
      <aside className='sidebar glass'>
        <div
          className='logo-container'
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <BrainCircuit className='text-indigo-400' size={32} />
            <h1 style={{ fontSize: '18px', margin: 0 }}>Nexus RAG</h1>
          </div>
          <button
            onClick={handleNewChat}
            style={{
              background: 'var(--accent-gradient)',
              border: 'none',
              borderRadius: '8px',
              padding: '6px 12px',
              color: 'white',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              fontSize: '12px',
              fontWeight: 'bold',
            }}
          >
            <PlusCircle size={14} /> New Chat
          </button>
        </div>

        <div
          className='upload-section'
          style={{
            borderBottom: '1px solid var(--surface-border)',
            paddingBottom: '12px',
          }}
        >
          <h2
            style={{
              fontSize: '14px',
              color: 'var(--text-secondary)',
              marginBottom: '8px',
            }}
          >
            CHATS
          </h2>
          <div
            className='file-list'
            style={{ maxHeight: '150px', overflowY: 'auto' }}
          >
            {chatSessions.map((session) => (
              <button
                key={session._id}
                type='button'
                onClick={() => setActiveChatId(session._id)}
                className={`session-row ${activeChatId === session._id ? 'active-session' : ''}`}
              >
                <div className='session-row-label'>
                  <Bot size={14} className='text-indigo-400' />
                  <span>{session.title || 'New Chat'}</span>
                </div>
                <button
                  type='button'
                  className='delete-chat-button'
                  onClick={(event) => {
                    event.stopPropagation();
                    handleDeleteChat(session._id);
                  }}
                  title='Delete chat'
                >
                  <Trash2 size={16} />
                </button>
              </button>
            ))}
          </div>
        </div>

        <div className='upload-section'>
          <h2
            style={{
              fontSize: '14px',
              color: 'var(--text-secondary)',
              marginBottom: '8px',
            }}
          >
            DOCUMENTS
          </h2>

          <div {...getRootProps()} className='dropzone'>
            <input {...getInputProps()} />
            {isUploading ? (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '8px',
                }}
              >
                <Loader2 className='animate-spin' size={32} color='#818cf8' />
                <span
                  style={{
                    fontSize: '10px',
                    color: '#a5b4fc',
                    fontWeight: 500,
                    letterSpacing: '0.05em',
                    textTransform: 'uppercase',
                  }}
                >
                  Indexing...
                </span>
              </div>
            ) : (
              <UploadCloud
                className={isDragActive ? 'text-indigo-400' : 'text-gray-400'}
                size={32}
              />
            )}
            <p>{isDragActive ? 'Drop it here...' : 'Upload PDF/Text'}</p>
          </div>

          <div className='file-list'>
            {files.map((file, idx) => (
              <motion.div
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                key={idx}
                className='file-item'
              >
                <div
                  style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
                >
                  <FileText size={16} className='text-gray-400' />
                  <span
                    style={{
                      maxWidth: '150px',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {file.name}
                  </span>
                </div>
                {file.status === 'uploading' ? (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                    }}
                  >
                    <span
                      style={{
                        fontSize: '10px',
                        color: '#818cf8',
                        fontWeight: 600,
                        fontStyle: 'italic',
                      }}
                    >
                      Indexing
                    </span>
                    <Loader2
                      size={14}
                      className='animate-spin'
                      color='#818cf8'
                    />
                  </div>
                ) : (
                  <CheckCircle2 size={16} className='text-green-500' />
                )}
              </motion.div>
            ))}
          </div>
        </div>

        {/* Website indexing section */}
        <div
          className='upload-section'
          style={{
            borderTop: '1px solid var(--surface-border)',
            paddingTop: '20px',
          }}
        >
          <h2
            style={{
              fontSize: '14px',
              color: 'var(--text-secondary)',
              marginBottom: '8px',
            }}
          >
            WEBSITES
          </h2>

          <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
            <div style={{ position: 'relative', flex: 1 }}>
              <Link
                size={14}
                style={{
                  position: 'absolute',
                  left: '10px',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  color: 'var(--text-muted)',
                }}
              />
              <input
                id='url-input'
                type='url'
                placeholder='https://example.com'
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleAddUrl()}
                disabled={isCrawling}
                style={{
                  width: '100%',
                  background: 'var(--surface-1)',
                  border: '1px solid var(--surface-border)',
                  borderRadius: '8px',
                  padding: '8px 10px 8px 30px',
                  fontSize: '12px',
                  color: 'var(--text-primary)',
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
            </div>
            <button
              id='add-url-button'
              onClick={handleAddUrl}
              disabled={isCrawling || !urlInput.trim()}
              style={{
                background:
                  isCrawling || !urlInput.trim()
                    ? 'var(--surface-1)'
                    : 'var(--accent-gradient)',
                border: 'none',
                borderRadius: '8px',
                padding: '8px 12px',
                cursor:
                  isCrawling || !urlInput.trim() ? 'not-allowed' : 'pointer',
                color: 'white',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                fontSize: '12px',
                fontWeight: 600,
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}
            >
              {isCrawling ? (
                <Loader2 size={14} className='animate-spin' />
              ) : (
                <Globe size={14} />
              )}
              {isCrawling ? 'Crawling' : 'Add'}
            </button>
          </div>

          <div className='file-list'>
            {websites.map((site, idx) => (
              <motion.div
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                key={idx}
                className='file-item'
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    minWidth: 0,
                  }}
                >
                  <Globe
                    size={16}
                    className='text-gray-400'
                    style={{ flexShrink: 0 }}
                  />
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        maxWidth: '140px',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontSize: '13px',
                      }}
                    >
                      {site.title !== site.url
                        ? site.title
                        : new URL(site.url).hostname}
                    </div>
                    {site.status === 'indexed' && site.pageCount > 0 && (
                      <div
                        style={{ fontSize: '10px', color: 'var(--text-muted)' }}
                      >
                        {site.pageCount} page{site.pageCount !== 1 ? 's' : ''}
                      </div>
                    )}
                  </div>
                </div>
                {site.status === 'crawling' ? (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                    }}
                  >
                    <span
                      style={{
                        fontSize: '10px',
                        color: '#818cf8',
                        fontWeight: 600,
                        fontStyle: 'italic',
                      }}
                    >
                      Crawling
                    </span>
                    <Loader2
                      size={14}
                      className='animate-spin'
                      color='#818cf8'
                    />
                  </div>
                ) : (
                  <CheckCircle2 size={16} className='text-green-500' />
                )}
              </motion.div>
            ))}
          </div>
        </div>

        <div
          className='sidebar-footer'
          style={{
            marginTop: 'auto',
            padding: '20px',
            borderTop: '1px solid var(--surface-border)',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
          }}
        >
          <button className='logout-button' type='button' onClick={logout}>
            Log Out
          </button>
          <p
            style={{ fontSize: '12px', color: 'var(--text-muted)', margin: 0 }}
          >
            Powered by Gemini 1.5 & Pinecone
          </p>
        </div>
      </aside>

      {/* Main Chat Area */}
      <main className='chat-main glass'>
        <header className='chat-header'>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div
              style={{
                background: 'var(--accent-gradient)',
                padding: '8px',
                borderRadius: '12px',
              }}
            >
              <Bot size={20} color='white' />
            </div>
            <div>
              <h2 style={{ fontSize: '16px', margin: 0 }}>
                AI Knowledge Assistant
              </h2>
              <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                {files.length > 0 || websites.length > 0
                  ? `${files.length} doc${files.length !== 1 ? 's' : ''} · ${websites.length} site${websites.length !== 1 ? 's' : ''} indexed`
                  : 'No sources indexed yet'}
              </p>
            </div>
          </div>
        </header>

        <section className='messages-container'>
          <AnimatePresence initial={false}>
            {messages.map((m) => (
              <motion.div
                key={m.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3 }}
                className={`message ${m.type}`}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '12px',
                  }}
                >
                  {m.type === 'bot' ? (
                    <Bot size={18} style={{ marginTop: '4px' }} />
                  ) : (
                    <User size={18} style={{ marginTop: '4px' }} />
                  )}
                  <div className='markdown-container'>
                    {m.type === 'bot' && m.confidenceScore !== undefined && (
                      <div 
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '4px',
                          padding: '2px 8px',
                          borderRadius: '12px',
                          fontSize: '10px',
                          fontWeight: 600,
                          marginBottom: '8px',
                          cursor: 'help',
                          color: m.confidenceScore >= 80 ? '#10b981' : m.confidenceScore >= 50 ? '#f59e0b' : '#ef4444',
                          background: m.confidenceScore >= 80 ? 'rgba(16, 185, 129, 0.1)' : m.confidenceScore >= 50 ? 'rgba(245, 158, 11, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                          border: `1px solid ${m.confidenceScore >= 80 ? 'rgba(16, 185, 129, 0.2)' : m.confidenceScore >= 50 ? 'rgba(245, 158, 11, 0.2)' : 'rgba(239, 68, 68, 0.2)'}`
                        }}
                        title={m.confidenceReasoning}
                      >
                        {m.confidenceScore >= 80 ? <CheckCircle2 size={12} /> : m.confidenceScore >= 50 ? <AlertCircle size={12} /> : <AlertTriangle size={12} />}
                        {m.confidenceScore >= 80 ? 'Highly Grounded' : m.confidenceScore >= 50 ? 'Partially Grounded' : 'Low Confidence'}
                        <span style={{opacity: 0.8}}>({m.confidenceScore}%)</span>
                      </div>
                    )}
                    {m.type === 'bot' ? (
                      (() => {
                        const { mainText, sources } = parseBotMessage(m.text);
                        const sourceIndex = Object.fromEntries(
                          sources.map((source) => [source.marker, source]),
                        );

                        return (
                          <>
                            <ReactMarkdown
                              remarkPlugins={[remarkGfm]}
                              components={{
                                p: ({ children, ...props }) => {
                                  const processText = (text: any): any => {
                                    if (typeof text === 'string') {
                                      const parts = text.split(/(\[[0-9]+\])/g);
                                      return parts.map((part, index) => {
                                        if (part.match(/^\[[0-9]+\]$/)) {
                                          const source = sourceIndex[part];
                                          const tooltip = source 
                                            ? `${source.sourceId}\n\n${source.snippet}` 
                                            : "Citation details not available for this message.";
                                          
                                          return (
                                            <span
                                              key={index}
                                              className='citation'
                                              data-tooltip={tooltip}
                                            >
                                              {part}
                                            </span>
                                          );
                                        }
                                        return part;
                                      });
                                    }
                                    return text;
                                  };

                                  return (
                                    <p {...props}>
                                      {Array.isArray(children)
                                        ? children.map(processText)
                                        : processText(children)}
                                    </p>
                                  );
                                },
                              }}
                            >
                              {mainText}
                            </ReactMarkdown>
                          </>
                        );
                      })()
                    ) : (
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {m.text}
                      </ReactMarkdown>
                    )}
                  </div>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
          {isAsking && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className='message bot'
            >
              <div
                style={{ display: 'flex', alignItems: 'center', gap: '12px' }}
              >
                <Bot size={18} />
                <TypingIndicator />
              </div>
            </motion.div>
          )}
          <div ref={messagesEndRef} />
        </section>

        <div className='input-container'>
          <input
            type='text'
            className='chat-input'
            placeholder={
              files.length > 0 || websites.length > 0
                ? 'Ask a question about your documents...'
                : 'Index a document or link to ask a question...'
            }
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleSend()}
            disabled={
              isAsking ||
              isUploading ||
              isCrawling ||
              (files.length === 0 && websites.length === 0)
            }
          />
          <button
            className='send-button'
            onClick={handleSend}
            disabled={
              isAsking ||
              isUploading ||
              isCrawling ||
              (files.length === 0 && websites.length === 0) ||
              !input.trim()
            }
          >
            {isAsking ? (
              <Loader2 className='animate-spin' size={20} />
            ) : (
              <Send size={20} />
            )}
          </button>
        </div>
      </main>
    </div>
  );
}

export default App;
