# ALLY — Web Accessibility Coach Agent

> Open access. Better experience.

Enterprise Web Accessibility Coach. Audits pasted UI markup (HTML/JSX/TSX/CSS/microcopy), uploaded web/document files, or live public webpage URLs (`https://...`) with practical `Issue -> Why it matters -> How to improve` WCAG guidance.

---

## Key Features & Guardrails

- **Dual-Mode AI Architecture (`Amazon Bedrock Nova Pro` + Claude Haiku fallback):** Automatically distinguishes natural conversational Q&A (`type: "chat"`) from structured enterprise analysis.
- **Strict File Validation & Detailed Rejections (`backend/services/file_validation.py`):** Pre- and post-extraction checks validate file size, binary/executable headers, encryption, corruption, and text extractability. Unsupported uploads return clear explanations of *why* the file was rejected and *how to fix* it.
- **Supported Inputs:** HTML, HTM, JSX, TSX, CSS, JS, TS, Markdown (.md), TXT, PDF (selectable text), Word (.docx), Excel (.xlsx), CSV, JSON, XML (up to 10 MB), plus public `http://`/`https://` web page URLs.
- **Enterprise BFSI Guardrails (`backend/services/guardrail_service.py`):** Blocks prompt injection, malware payloads, tampered financial ledgers, invalid calendar dates, and redacts sensitive PII/secrets (`PCI-DSS` / `DPDP`).

---

## Prerequisites

- **Python** `3.10+`
- **Node.js** `18+` and `npm`
- **AWS Account** with **Amazon Bedrock** model access enabled in `us-east-1` (`us.amazon.nova-pro-v1:0` and `us.anthropic.claude-3-haiku-20240307-v1:0`)
- AWS credentials configured locally (`aws configure`, IAM role, or `.env`)

---

## Run Locally (Step-by-Step)

### 1. Clone the Repository

```bash
git clone <your-repo-url>
cd ally-accessibility-coach-agent
```

### 2. Start the Backend (`FastAPI`)

**Windows (PowerShell / CMD):**

```bash
cd backend
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
# Edit backend/.env if needed (AWS_REGION, ALLY_DOCS_BUCKET, or AWS keys)
uvicorn main:app --reload --port 8010
```

**macOS / Linux:**

```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn main:app --reload --port 8010
```

Backend API will run at `http://localhost:8010` (`/api/health` for health check).

### 3. Start the Frontend (`React + Vite`)

Open a new terminal from the repository root:

```bash
cd frontend
npm install
npm run dev
```

Open **`http://localhost:5183`** in your browser. Vite proxies `/api/*` requests to `http://localhost:8010`.

---

## Build & Deploy to AWS (Lambda + API Gateway + S3 + CloudFront)

1. Verify your AWS CLI / environment credentials (`aws sts get-caller-identity`).
2. From the repository root (ally-accessibility-coach-agent/):

```bash
cd frontend
npm install
npm run build
cd ..
python deploy_aws.py
```

`deploy_aws.py` packages the Python Lambda (`ally-backend-api`), configures HTTP API Gateway (`ally-http-api`), writes `frontend/.env.production`, builds & uploads `frontend/dist` to S3, and invalidates CloudFront.

### Verify Live Deployment

```bash
python test_live.py --api https://<your-api-id>.execute-api.us-east-1.amazonaws.com --cf https://<your-dist>.cloudfront.net
```

---

## Project Structure

```text
ally-accessibility-coach-agent/
├── deploy_aws.py               # Automated AWS deployment (Lambda, API Gateway, S3, CloudFront)
├── backend/
│   ├── main.py                 # FastAPI local dev server
│   ├── lambda_function.py      # AWS Lambda HTTP handler
│   ├── services/               # AI coaching/analysis, file validation, guardrails & document extraction
│   ├── requirements.txt        # Python dependencies
│   └── .env.example            # Environment variable template
└── frontend/
    ├── index.html
    ├── package.json
    ├── vite.config.js          # Vite dev server & /api proxy configuration
    └── src/
        ├── App.jsx             # Main application state, workspace & history
        ├── components/         # Specialized result cards, sidebar & document viewer
        └── services/           # Frontend API client
```

---

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` (or `/health`) | Health check |
| `POST` | `/api/review` | Primary workspace endpoint |
| `POST` | `/api/get-upload-url` | Generate presigned S3 upload URL for large files |
| `GET` | `/api/view-document` | Inspect uploaded document / fetched webpage preview |
