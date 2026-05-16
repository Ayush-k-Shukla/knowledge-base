# Multi-Source RAG

A full-stack Retrieval-Augmented Generation (RAG) proof-of-concept built with:

- **React 19 + Vite + TypeScript** frontend with animations and markdown rendering
- **NestJS + TypeScript** backend with Swagger API documentation
- **MongoDB** for chat, document, website, and user persistence
- **Pinecone** for vector embeddings and semantic retrieval (3072-dimensional vectors)
- **Google Gemini 1.5** (gemini-embedding-001 for embeddings, gemini-2.5-flash-lite for generation)
- **Cohere** optional reranking (rerank-english-v3.0) and scoring
- **PDF/text upload** and **website crawling** for multi-source knowledge ingestion

## What this project does

This app lets authenticated users upload documents and index websites into a shared RAG workspace, then ask questions over the combined knowledge sources.

Key features:

- User registration and authentication with JWT
- Chat session management and persistent history with auto-generated titles
- Document upload support for PDF and plain text files
- Website crawling and indexing for live URL sources
- Semantic embeddings stored in Pinecone with multi-query expansion
- **Semantic Caching** for embeddings and LLM responses in MongoDB (using Atlas Vector Search)
- Question answering backed by retrieved context with citations and source snippets
- **Agentic Routing** with clarification requests and web search fallback
- **Confidence Scoring** for answer grounding evaluation
- Swagger API documentation for the backend

## Architecture overview

```mermaid
flowchart TD
  subgraph Client[Frontend]
    U[User] -->|Login / Register| AuthUI[Auth UI]
    U -->|Upload PDF / TXT| UploadUI[Upload UI]
    U -->|Add website URL| WebsiteUI[Website UI]
    U -->|Ask question| ChatUI[Chat UI]
    AuthUI -->|JWT token| LocalStorage
    ChatUI -->|HTTP requests| API
    UploadUI -->|HTTP file upload| API
    WebsiteUI -->|HTTP index request| API
  end

  subgraph Server[Backend]
    API[API Controllers]
    API --> AuthSvc[Auth Service]
    API --> ChatSvc[Chat Service]
    API --> DocSvc[Document Service]
    API --> WebSvc[Website Service]

    %% Persistence
    Mongo[MongoDB (chunks, docs, websites, semantic cache)]

    %% Vector and AI
    VecSvc[Vector Service]
    Pinecone[Pinecone]
    AiSvc[AI Service]
    LLM[Google Gemini / Cohere]
    CacheSvc[Semantic Cache Service (Atlas Vector Search or Mongo)]

    AuthSvc --> Mongo
    ChatSvc --> Mongo
    DocSvc --> Mongo
    WebSvc --> Mongo

    %% Hybrid retrieval paths
    DocSvc --> VecSvc
    WebSvc --> VecSvc
    DocSvc --> Mongo
    WebSvc --> Mongo

    ChatSvc --> VecSvc
    ChatSvc --> Mongo
    ChatSvc --> AiSvc
    ChatSvc --> CacheSvc

    AiSvc --> CacheSvc
    CacheSvc --> Mongo
    AiSvc -->|Embeddings / generation| LLM
    VecSvc -->|upsert / query| Pinecone
  end

  Client -->|CORS / HTTP| Server
```

## Detailed Flows

### Indexing Flow

```mermaid
flowchart TD
  A[User uploads file<br>or indexes website] --> B{Type?}
  B -->|Document| C[Extract text<br>from PDF/TXT]
  B -->|Website| D[Crawl website<br>pages]
  C --> E[Chunk text<br>into segments]
  D --> E
  E --> F[Generate embeddings<br>for each chunk (parallel)]
  F --> G[Batch upsert vectors<br>to Pinecone]
  G --> H[Save chunks & metadata<br>to MongoDB (for keyword search / Atlas Search)]
  H --> I[Indexing complete]
```

### Question Answering Flow

```mermaid
flowchart TD
  A[User asks question] --> B[Save question<br>to MongoDB (user message)]
  B --> C[Generate embedding<br>for question]
  C --> D[Check Semantic Cache<br>for similar question]
  D --> E{Cache Hit?}
  E -->|Yes| F[Return cached answer<br>and save bot message]
  E -->|No| G[Rewrite query<br>into 3 variations]
  G --> H[For each rewritten<br>query (parallel):]
  H --> I[Generate embedding]
  I --> J[Query Pinecone (vector)<br>and Mongo keyword search]
  J --> K[Combine results and apply<br>Reciprocal Rank Fusion (RRF)]
  K --> L[De-duplicate & limit results]
  L --> M[Rerank matches with Cohere]
  M --> N[Build context chunks<br>from top matches]
  N --> O[Evaluate context sufficiency<br>(Agentic Routing)]
  O --> P{Action?}
  P -->|ASK_CLARIFICATION| Q[Ask for clarification<br>and return message]
  P -->|WEB_SEARCH| R[Perform web search,<br>append synthetic web chunks]
  P -->|ANSWER| S[Proceed to generate answer<br>with citations]
  R --> S
  S --> T[Format answer with<br>citations and snippets]
  T --> U[Calculate confidence score]
  U --> V[Save answer to MongoDB<br>and semantic cache (response)]
  V --> W[Return answer to user]
  F --> W
  Q --> W
```

### Backend

1. Open a terminal and go to the `server` directory:

````bash
cd server

2. Install dependencies:

```bash
npm install
````

3. Create a `.env` file with at least these values:

```ini
MONGODB_URI=mongodb://localhost:27017/multi-source-rag
PINECONE_API_KEY=your_pinecone_api_key
PINECONE_INDEX_NAME=your_pinecone_index_name
GEMINI_API_KEY=your_google_gemini_api_key
COHERE_API_KEY=your_cohere_api_key   # optional
PORT=3000
```

4. Start the backend server in development mode:

```bash
npm run start:dev
```

5. API docs will be available at:

```text
http://localhost:3000/api
```

### Frontend

1. Open another terminal and go to the `client` directory:

```bash
cd client
```

2. Install dependencies:

```bash
npm install
```

3. Start the frontend dev server:

```bash
npm run dev
```

4. Open the app in your browser, usually at:

```text
http://localhost:5173
```

> If your backend runs on a different host or port, update `API_BASE` in `client/src/App.tsx`.

## How to use it

1. Register or login with an email and password.
2. Create a new chat session or select an existing session (titles are auto-generated from conversations).
3. Upload a PDF or text file using the drag-and-drop document uploader.
4. Add a website URL to crawl and index its content (supports up to 15 pages per site).
5. Ask questions in the chat box to get answers generated from the uploaded documents and indexed webpages.
6. The system returns answers with citations from the retrieved sources, confidence scores, and source snippets.
7. If a question is unclear, the system may ask for clarification.
8. If external knowledge is needed, the system can perform web searches to supplement answers.
9. Chat sessions can be deleted using the trash icon next to each chat in the sidebar.

## Advanced Features

### Semantic Caching

- **Embedding Cache**: Avoids redundant embedding API calls for identical text
- **Response Cache**: Stores complete Q&A pairs for similar questions using semantic similarity
- **Multi-level Caching**: In-memory LRU cache + persistent MongoDB storage with TTL

### Agentic Routing

- **Context Evaluation**: AI assesses if retrieved context is sufficient to answer questions
- **Clarification Requests**: When questions are ambiguous, the system asks for clarification
- **Web Search Fallback**: For questions requiring external knowledge, performs DuckDuckGo searches

### Confidence Scoring

- **Grounding Evaluation**: AI audits answers for factual accuracy and context reliance
- **Visual Indicators**: Color-coded confidence badges (green ≥80%, yellow ≥50%, red <50%)
- **Detailed Reasoning**: Hover tooltips explain confidence assessment

### Multi-Query Expansion

- **Query Rewriting**: Generates 3 optimized search queries from user input
- **Parallel Retrieval**: Executes multiple vector searches simultaneously
- **Deduplication**: Merges and removes duplicate results before reranking

### Text Processing

- **Chunking Strategy**: Documents and websites are split into 1000-character chunks with 200-character overlap
- **PDF Processing**: Uses pdf-parse library for text extraction
- **Website Crawling**: Follows same-origin links up to 15 pages per site

## Important endpoints used by the frontend

- `POST /auth/register`
- `POST /auth/login`
- `POST /chat/session`
- `GET /chat/sessions`
- `GET /chat/history/:chatId`
- `POST /chat/ask/:chatId`
- `DELETE /chat/:chatId`
- `POST /document/upload/:chatId`
- `GET /document/:chatId`
- `POST /website/index/:chatId`
- `GET /website/:chatId`

## Notes

- The backend uses `app.enableCors()` so the frontend can connect from a different port.
- Authentication uses a bearer token stored in browser local storage.
- The app relies on external AI providers and Pinecone, so valid API keys and working connectivity are required.
- Swagger docs are enabled for the Nest backend and can help explore available API routes.
- Website crawling is limited to same-origin links and respects robots.txt (via fetch headers).
- Semantic caching reduces API costs and improves response times for similar questions.
- Confidence scores indicate how well answers are grounded in the provided context.
- Agentic routing automatically handles clarification requests and web search fallbacks.

---

## Repository layout

- `client/` — React + Vite UI
- `server/` — NestJS API and RAG backend
- `server/src/ai/` — AI integrations, prompt logic, and semantic cache
- `server/src/vector/` — Pinecone vector storage
- `server/src/document/` — PDF/text upload and storage
- `server/src/website/` — URL crawling and website indexing
- `server/src/chat/` — chat and question-answering flow
- `server/src/auth/` — authentication and JWT guard
- `server/src/user/` — user schema and user persistence

Enjoy exploring the multi-source RAG app!
