import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useDropzone } from 'react-dropzone';
import axios from 'axios';
import { 
  Send, 
  FileText, 
  UploadCloud, 
  CheckCircle2, 
  Loader2, 
  Bot, 
  User,
  PlusCircle,
  BrainCircuit
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

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

function App() {
  const [messages, setMessages] = useState<Message[]>([
    { id: '1', type: 'bot', text: 'Hello! I am your AI Knowledge Assistant. Upload a PDF or text document, and I will help you answer questions about it.' }
  ]);
  const [input, setInput] = useState('');
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [isAsking, setIsAsking] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [docsRes, chatRes] = await Promise.all([
          axios.get(`${API_BASE}/document`),
          axios.get(`${API_BASE}/chat/history`)
        ]);

        if (docsRes.data) {
          setFiles(docsRes.data.map((d: any) => ({ name: d.filename, status: 'indexed' })));
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
  }, []);

  useEffect(scrollToBottom, [messages]);


  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    const file = acceptedFiles[0];
    if (!file) return;

    setIsUploading(true);
    setFiles(prev => [...prev, { name: file.name, status: 'uploading' }]);

    const formData = new FormData();
    formData.append('file', file);

    try {
      await axios.post(`${API_BASE}/document/upload`, formData, {
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
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({ 
    onDrop,
    accept: { 'application/pdf': ['.pdf'], 'text/plain': ['.txt'] },
    multiple: false
  });

  const handleSend = async () => {
    if (!input.trim() || isAsking) return;

    const userMessage: Message = { id: Date.now().toString(), type: 'user', text: input };
    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsAsking(true);

    try {
      const response = await axios.post(`${API_BASE}/chat/ask`, { question: input });
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
        <div className="logo-container">
          <BrainCircuit className="text-indigo-400" size={32} />
          <h1>Nexus RAG</h1>
        </div>

        <div className="upload-section">
          <h2 style={{ fontSize: '14px', color: 'var(--text-secondary)', marginBottom: '8px' }}>DOCUMENTS</h2>
          
          <div {...getRootProps()} className="dropzone">
            <input {...getInputProps()} />
            {isUploading ? (
              <Loader2 className="animate-spin text-indigo-400" size={32} />
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
                  <Loader2 size={16} className="animate-spin text-indigo-400" />
                ) : (
                  <CheckCircle2 size={16} className="text-green-500" />
                )}
              </motion.div>
            ))}
          </div>
        </div>

        <div style={{ padding: '24px', borderTop: '1px solid var(--surface-border)' }}>
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
                {files.length > 0 ? `${files.length} documents indexed` : 'No documents indexed yet'}
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
                  <span>{m.text}</span>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
          {isAsking && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="message bot">
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <Loader2 className="animate-spin" size={18} />
                <span>Thinking...</span>
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
            disabled={isAsking}
          />
          <button 
            className="send-button" 
            onClick={handleSend}
            disabled={isAsking || !input.trim()}
          >
            {isAsking ? <Loader2 className="animate-spin" size={20} /> : <Send size={20} />}
          </button>
        </div>
      </main>
    </div>
  );
}

export default App;
