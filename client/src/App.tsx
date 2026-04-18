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
  UploadCloud,
  User
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';


const API_BASE = 'http://localhost:3001';

interface Message {
  id: string;
  type: 'user' | 'bot';
  text: string;
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
  <div className="typing-dots">
    {[0, 1, 2].map((i) => (
      <motion.div
        key={i}
        className="dot"
        animate={{
          opacity: [0.4, 1, 0.4],
          scale: [1, 1.2, 1]
        }}
        transition={{
          duration: 1.2,
          repeat: Infinity,
          delay: i * 0.2,
          ease: "easeInOut"
        }}
      />
    ))}
  </div>
);


function App() {
  const [messages, setMessages] = useState<Message[]>([
    { id: '1', type: 'bot', text: 'Hello! I am your AI Knowledge Assistant. Upload a PDF or text document, and I will help you answer questions about it.' }
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
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const fetchSessions = useCallback(async () => {
    try {
      const res = await axios.get(`${API_BASE}/chat/sessions`);
      if (res.data && res.data.length > 0) {
        setChatSessions(res.data);
        if (!activeChatId) {
          setActiveChatId(res.data[0]._id);
        }
      } else {
        handleNewChat();
      }
    } catch (error) {
      console.error('Failed to fetch sessions', error);
    }
  }, [activeChatId]);

  useEffect(() => {
    fetchSessions();
  }, []);

  const handleNewChat = async () => {
    try {
      const res = await axios.post(`${API_BASE}/chat/session`);
      setChatSessions(prev => [res.data, ...prev]);
      setActiveChatId(res.data._id);
    } catch(e) { console.error('Failed to create session', e); }
  };

  useEffect(() => {
    if (!activeChatId) return;

    const fetchData = async () => {
      setFiles([]);
      setWebsites([]);
      setMessages([{ id: '1', type: 'bot', text: 'Hello! I am your AI Knowledge Assistant. Upload a PDF or text document, and I will help you answer questions about it.' }]);

      try {
        const [docsRes, chatRes, websitesRes] = await Promise.all([
          axios.get(`${API_BASE}/document/${activeChatId}`),
          axios.get(`${API_BASE}/chat/history/${activeChatId}`),
          axios.get(`${API_BASE}/website/${activeChatId}`),
        ]);

        if (docsRes.data) {
          setFiles(docsRes.data.map((d: any) => ({ name: d.filename, status: 'indexed' })));
        }

        if (websitesRes.data) {
          setWebsites(websitesRes.data.map((w: any) => ({
            url: w.url,
            title: w.title || w.url,
            pageCount: w.pageCount,
            status: 'indexed',
          })));
        }

        if (chatRes.data && chatRes.data.length > 0) {
          setMessages(chatRes.data.map((m: any) => ({
            id: m._id,
            type: m.role,
            text: m.content
          })));
        }
      } catch (error) {
        console.error('Failed to fetch data', error);
      }
    };
    fetchData();
  }, [activeChatId]);


  useEffect(scrollToBottom, [messages]);


  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    if (!activeChatId) return;
    const file = acceptedFiles[0];
    if (!file) return;

    setIsUploading(true);
    setFiles(prev => [...prev, { name: file.name, status: 'uploading' }]);

    const formData = new FormData();
    formData.append('file', file);

    try {
      await axios.post(`${API_BASE}/document/upload/${activeChatId}`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      setFiles(prev => prev.map(f => f.name === file.name ? { ...f, status: 'indexed' } : f));
    } catch (error) {
      console.error('Upload failed', error);
      alert('Failed to upload document. Make sure the backend is running and Pinecone is configured correctly.');
      setFiles(prev => prev.filter(f => f.name !== file.name));
    } finally {
      setIsUploading(false);
    }
  }, [activeChatId]);

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
    setWebsites(prev => [
      { url: trimmed, title: trimmed, pageCount: 0, status: 'crawling' },
      ...prev.filter(w => w.url !== trimmed),
    ]);
    setUrlInput('');

    try {
      const res = await axios.post(`${API_BASE}/website/index/${activeChatId}`, { url: trimmed, depth: 1 });
      setWebsites(prev =>
        prev.map(w =>
          w.url === trimmed
            ? { url: trimmed, title: res.data.title, pageCount: res.data.pageCount, status: 'indexed' }
            : w,
        ),
      );
    } catch (error) {
      console.error('Website indexing failed', error);
      alert('Failed to index website. Check the URL and server logs.');
      setWebsites(prev => prev.filter(w => w.url !== trimmed));
    } finally {
      setIsCrawling(false);
    }
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'application/pdf': ['.pdf'], 'text/plain': ['.txt'] },
    multiple: false
  });

  const handleSend = async () => {
    if (!input.trim() || isAsking || !activeChatId) return;

    const userMessage: Message = { id: Date.now().toString(), type: 'user', text: input };
    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsAsking(true);

    try {
      const response = await axios.post(`${API_BASE}/chat/ask/${activeChatId}`, { question: input });
      const botMessage: Message = { id: (Date.now() + 1).toString(), type: 'bot', text: response.data.answer };
      setMessages(prev => [...prev, botMessage]);
    } catch (error) {
      console.error('Ask failed', error);
      const errorMessage: Message = { id: (Date.now() + 1).toString(), type: 'bot', text: 'Sorry, I encountered an error while processing your request.' };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setIsAsking(false);
    }
  };

  return (
    <div className="app-container">
      {/* Sidebar */}
      <aside className="sidebar glass">
        <div className="logo-container" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <BrainCircuit className="text-indigo-400" size={32} />
            <h1 style={{ fontSize: '18px', margin: 0 }}>Nexus RAG</h1>
          </div>
          <button
            onClick={handleNewChat}
            style={{ background: 'var(--accent-gradient)', border: 'none', borderRadius: '8px', padding: '6px 12px', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', fontWeight: 'bold' }}
          >
            <PlusCircle size={14} /> New Chat
          </button>
        </div>

        <div className="upload-section" style={{ borderBottom: '1px solid var(--surface-border)', paddingBottom: '12px' }}>
          <h2 style={{ fontSize: '14px', color: 'var(--text-secondary)', marginBottom: '8px' }}>CHATS</h2>
          <div className="file-list" style={{ maxHeight: '150px', overflowY: 'auto' }}>
            {chatSessions.map((session) => (
              <div
                key={session._id}
                onClick={() => setActiveChatId(session._id)}
                style={{
                  padding: '8px',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  background: activeChatId === session._id ? 'var(--surface-1)' : 'transparent',
                  border: activeChatId === session._id ? '1px solid var(--surface-border)' : '1px solid transparent',
                  display: 'flex', alignItems: 'center', gap: '8px'
                }}
              >
                <Bot size={14} className="text-indigo-400" />
                <span style={{ fontSize: '13px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {session.title || 'New Chat'}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="upload-section">
          <h2 style={{ fontSize: '14px', color: 'var(--text-secondary)', marginBottom: '8px' }}>DOCUMENTS</h2>

          <div {...getRootProps()} className="dropzone">
            <input {...getInputProps()} />
            {isUploading ? (
              <div className="flex flex-col items-center gap-2">
                <Loader2 className="animate-spin text-indigo-400" size={32} />
                <span className="text-[10px] text-indigo-300 font-medium tracking-wider uppercase">Indexing...</span>
              </div>
            ) : (
              <UploadCloud className={isDragActive ? 'text-indigo-400' : 'text-gray-400'} size={32} />
            )}
            <p>{isDragActive ? 'Drop it here...' : 'Upload PDF/Text'}</p>
          </div>

          <div className="file-list">
            {files.map((file, idx) => (
              <motion.div
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                key={idx}
                className="file-item"
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <FileText size={16} className="text-gray-400" />
                  <span style={{
                    maxWidth: '150px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}>
                    {file.name}
                  </span>
                </div>
                {file.status === 'uploading' ? (
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-indigo-400 font-semibold italic">Indexing</span>
                    <Loader2 size={14} className="animate-spin text-indigo-400" />
                  </div>
                ) : (
                  <CheckCircle2 size={16} className="text-green-500" />
                )}
              </motion.div>
            ))}
          </div>
        </div>

        {/* Website indexing section */}
        <div className="upload-section" style={{ borderTop: '1px solid var(--surface-border)', paddingTop: '20px' }}>
          <h2 style={{ fontSize: '14px', color: 'var(--text-secondary)', marginBottom: '8px' }}>WEBSITES</h2>

          <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
            <div style={{ position: 'relative', flex: 1 }}>
              <Link size={14} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
              <input
                id="url-input"
                type="url"
                placeholder="https://example.com"
                value={urlInput}
                onChange={e => setUrlInput(e.target.value)}
                onKeyPress={e => e.key === 'Enter' && handleAddUrl()}
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
              id="add-url-button"
              onClick={handleAddUrl}
              disabled={isCrawling || !urlInput.trim()}
              style={{
                background: isCrawling || !urlInput.trim() ? 'var(--surface-1)' : 'var(--accent-gradient)',
                border: 'none',
                borderRadius: '8px',
                padding: '8px 12px',
                cursor: isCrawling || !urlInput.trim() ? 'not-allowed' : 'pointer',
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
              {isCrawling ? <Loader2 size={14} className="animate-spin" /> : <Globe size={14} />}
              {isCrawling ? 'Crawling' : 'Add'}
            </button>
          </div>

          <div className="file-list">
            {websites.map((site, idx) => (
              <motion.div
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                key={idx}
                className="file-item"
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                  <Globe size={16} className="text-gray-400" style={{ flexShrink: 0 }} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{
                      maxWidth: '140px',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      fontSize: '13px',
                    }}>
                      {site.title !== site.url ? site.title : new URL(site.url).hostname}
                    </div>
                    {site.status === 'indexed' && site.pageCount > 0 && (
                      <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                        {site.pageCount} page{site.pageCount !== 1 ? 's' : ''}
                      </div>
                    )}
                  </div>
                </div>
                {site.status === 'crawling' ? (
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-indigo-400 font-semibold italic">Crawling</span>
                    <Loader2 size={14} className="animate-spin text-indigo-400" />
                  </div>
                ) : (
                  <CheckCircle2 size={16} className="text-green-500" />
                )}
              </motion.div>
            ))}
          </div>
        </div>

        <div style={{ padding: '24px', borderTop: '1px solid var(--surface-border)', marginTop: 'auto' }}>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Powered by Gemini 1.5 & Pinecone</p>
        </div>
      </aside>

      {/* Main Chat Area */}
      <main className="chat-main glass">
        <header className="chat-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{ background: 'var(--accent-gradient)', padding: '8px', borderRadius: '12px' }}>
              <Bot size={20} color="white" />
            </div>
            <div>
              <h2 style={{ fontSize: '16px', margin: 0 }}>AI Knowledge Assistant</h2>
              <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                {files.length > 0 || websites.length > 0
                  ? `${files.length} doc${files.length !== 1 ? 's' : ''} · ${websites.length} site${websites.length !== 1 ? 's' : ''} indexed`
                  : 'No sources indexed yet'}
              </p>
            </div>
          </div>
        </header>

        <section className="messages-container">
          <AnimatePresence initial={false}>
            {messages.map((m) => (
              <motion.div
                key={m.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3 }}
                className={`message ${m.type}`}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
                  {m.type === 'bot' ? <Bot size={18} style={{ marginTop: '4px' }} /> : <User size={18} style={{ marginTop: '4px' }} />}
                  <div className="markdown-container">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {m.text}
                    </ReactMarkdown>
                  </div>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
          {isAsking && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="message bot">
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <Bot size={18} />
                <TypingIndicator />
              </div>
            </motion.div>
          )}
          <div ref={messagesEndRef} />
        </section>

        <div className="input-container">
          <input
            type="text"
            className="chat-input"
            placeholder="Ask a question about your documents..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleSend()}
            disabled={isAsking || isUploading || isCrawling}
          />
          <button
            className="send-button"
            onClick={handleSend}
            disabled={isAsking || isUploading || isCrawling || !input.trim()}
          >
            {isAsking ? <Loader2 className="animate-spin" size={20} /> : <Send size={20} />}
          </button>
        </div>
      </main>
    </div>
  );
}

export default App;
